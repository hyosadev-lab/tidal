import {
  getPositions,
  savePositions,
  getTrades,
  saveTrades,
  getLearnings,
  addSoldToken,
  updatePerformance,
  recordDecision,
  updateDecisionOutcome,
} from "../storage/db";
import { generateLearnings } from "../agent/learner";
import {
  getTokenDetails,
} from "../gmgn/market";
import { executeSell, checkOrderStatus } from "../gmgn/trade";
import { getManageDecision } from "../agent/manager";
import type { Position, Trade, TokenData } from "../storage/types";
import { logger } from "../utils/logger";
import { delay } from "../utils/concurrency";

const CHAIN = process.env.GMGN_CHAIN || "sol";
const WALLET_ADDRESS = process.env.GMGN_WALLET_ADDRESS || "";
const SLIPPAGE = parseFloat(process.env.SLIPPAGE || "0.15");
const MANAGE_INTERVAL_MINUTES = parseFloat(process.env.MANAGE_INTERVAL_MINUTES || "0.1667");
const MANAGE_INTERVAL_MS = MANAGE_INTERVAL_MINUTES * 60 * 1000;
const DRY_RUN = process.env.DRY_RUN === "true";

// Prevent overlapping interval processing
let isMonitoring = false;

export async function startManagingSession() {
  logger.info("Starting managing session");

  setInterval(async () => {
    if (isMonitoring) {
      logger.info("Skipping monitor: previous cycle still running");
      return;
    }

    isMonitoring = true;
    try {
      await monitorPositions();
    } catch (error) {
      logger.error("Error in managing loop", { error: String(error) });
    } finally {
      isMonitoring = false;
    }
  }, MANAGE_INTERVAL_MS);
}

async function monitorPositions() {
  const positions = await getPositions();

  if (positions.length === 0) {
    logger.info("No open positions to monitor");
    return;
  }

  logger.info(`Monitoring ${positions.length} positions`);

  const updatedPositions: Position[] = [];

  for (const position of positions) {
    const processedPosition = await processPosition(position);
    if (processedPosition) {
      updatedPositions.push(processedPosition);
    }
    // If processedPosition is null, it means the position was sold (and executeSellOrder handled saving)
  }

  // Save updated positions (those that were not sold)
  if (updatedPositions.length > 0) {
    await savePositions(updatedPositions);
  }

  await generateLearnings();
}

async function processPosition(position: Position): Promise<Position | null> {
  try {
    // 1. Fetch all token data in single call (price, kline, security, order flow)
    const details = await getTokenDetails(CHAIN, position.tokenAddress);
    const currentPrice = details.price;
    const priceChange1h = details.priceChange1h;

    // Update position PnL
    position.currentPrice = currentPrice;
    position.currentMarketCap =
      position.entryMarketCap * (currentPrice / position.entryPrice); // Approximate

    // Update Peak Price (for reference, but not used for hard rules)
    if (!position.peakPrice || currentPrice > position.peakPrice) {
      position.peakPrice = currentPrice;
      position.peakPriceTimestamp = Date.now();
    }

    // costSol is the SOL amount spent at entry
    // Calculate current SOL value using price ratio: costSol * (currentPrice / entryPrice)
    const priceRatio = currentPrice / position.entryPrice;
    const currentValueSol = position.costSol * priceRatio;
    position.unrealizedPnlSol = currentValueSol - position.costSol;

    position.unrealizedPnlPercent =
      ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
    position.lastUpdated = Date.now();

    // 2. AI Decision - use data from getTokenDetails (no redundant API calls)
    const learnings = await getLearnings();
    const tokenData: TokenData = {
      address: position.tokenAddress,
      symbol: position.tokenSymbol,
      name: position.tokenName,
      price: currentPrice,
      priceChange1h: priceChange1h,
      usdMarketCap: details.usdMarketCap || position.currentMarketCap || 0,
      kline5mData: details.kline5mData,
      topTradersSummary: details.topTradersSummary,
      orderFlowSummary: details.orderFlowSummary,
      // Data from token details (all in one call)
      liquidity: details.liquidity || 0,
      volume1h: details.volume1h,
      volumeDeltas5m: details.volumeDeltas5m,
      holderCount: details.holderCount || 0,
      smartDegenCount: details.smartDegenCount || 0,
      renownedCount: details.renownedCount || 0,
      top10HolderRate: details.top10HolderRate || 0,
      creatorTokenStatus: details.creatorTokenStatus || "",
      creatorBalanceRate: details.creatorBalanceRate || 0,
      // Data from token security
      rugRatio: details.rugRatio || 0,
      bundlerTraderAmountRate: details.bundlerTraderAmountRate || 0,
      ratTraderAmountRate: details.ratTraderAmountRate || 0,
      isWashTrading: details.isWashTrading || false,
      launchpadPlatform: details.launchpadPlatform || "",
      renouncedMint: details.renouncedMint || false,
      renouncedFreezeAccount: details.renouncedFreezeAccount || false,
      hasAtLeastOneSocial: details.hasAtLeastOneSocial || false,
      ctoFlag: details.ctoFlag || false,
    };

    const decision = await getManageDecision(position, tokenData, learnings);

    // Record decision
    const decisionRecord = await recordDecision({
      tokenAddress: position.tokenAddress,
      tokenSymbol: position.tokenSymbol,
      decisionType: decision.action === "SELL" ? "SELL" : "HOLD",
      confidence: decision.confidence,
      reasoning: decision.reasoning,
      signals: decision.signals,
      outcome: "pending",
      aiReasoning: decision.reasoning,
    });

    if (decision.action === "SELL") {
      logger.info(
        `Decision for ${position.tokenSymbol}: ${decision.action} (${decision.confidence}%) {${decision.reasoning}}`,
      );

      const result = await executeSellOrder({
        exitReason: "ai_decision",
        position,
        signalsUsed: decision.signals,
        aiReasoning: decision.reasoning,
        decisionId: decisionRecord.id, // Pass decision ID for outcome update
      });
      const isSold = !result.find(
        (p) => p.tokenAddress === position.tokenAddress,
      );
      if (isSold) {
        await savePositions(result);
        // Update decision outcome to success/failure based on trade result
        // (This will be handled in executeSellOrder after order confirmation)
        return null; // Position sold
      }
      // If not sold (error), update decision outcome to failure
      await updateDecisionOutcome(decisionRecord.id, "failure", {
        exitReason: "execution_failed",
      });
      return position;
    } else {
      // Position held - update decision outcome to executed
      await updateDecisionOutcome(decisionRecord.id, "executed", {
        exitReason: "hold_decision",
        holdingDurationMs: Date.now() - position.entryTimestamp,
      });
      return position;
    }
  } catch (error) {
    logger.error(`Error processing position ${position.tokenSymbol}`, {
      error: String(error),
    });
    return position; // Return unchanged position on error
  }
}

async function executeSellOrder({
  position,
  exitReason,
  aiReasoning,
  signalsUsed,
  decisionId,
}: {
  position: Position;
  exitReason: string;
  aiReasoning?: string;
  signalsUsed?: string[];
  decisionId?: string;
}): Promise<Position[]> {
  if (!WALLET_ADDRESS) {
    logger.error("WALLET_ADDRESS not set, cannot execute sell");
    return [];
  }

  if (DRY_RUN) {
    logger.info(
      `[DRY RUN] Sell ${position.tokenSymbol} - Exit Reason: ${exitReason}`,
    );

    // Update position as sold (remove from list)
    const positions = await getPositions();
    const filtered = positions.filter(
      (p) => p.tokenAddress !== position.tokenAddress,
    );

    // Add to trades history
    const trade: Trade = {
      id: crypto.randomUUID(),
      tokenAddress: position.tokenAddress,
      tokenSymbol: position.tokenSymbol,
      tokenName: position.tokenName,
      action: "SELL",
      inputAmount: position.amountToken,
      inputAmountSol: position.costSol,
      outputAmount: "0",
      priceAtTrade: position.currentPrice || 0,
      marketCapAtTrade: position.currentMarketCap || 0,
      timestamp: Date.now(),
      orderId: "dry-run-" + crypto.randomUUID(),
      orderStatus: "confirmed",
      isDryRun: true,

      entryPrice: position.entryPrice,
      entryMarketCap: position.entryMarketCap,
      exitPrice: position.currentPrice || 0,
      exitMarketCap: position.currentMarketCap || 0,
      pnlSol: position.unrealizedPnlSol,
      pnlPercent: position.unrealizedPnlPercent,
      holdingDurationMs: Date.now() - position.entryTimestamp,
      exitReason: exitReason as any,

      aiReasoning,
      signalsUsed,
    };

    const trades = await getTrades();
    trades.push(trade);
    await saveTrades(trades);
    await updatePerformance();

    // Record sold token for cooldown
    await addSoldToken({
      address: position.tokenAddress,
      symbol: position.tokenSymbol,
    });

    // Update decision outcome
    if (decisionId) {
      await updateDecisionOutcome(decisionId, "success", {
        pnlSol: position.unrealizedPnlSol,
        pnlPercent: position.unrealizedPnlPercent,
        exitReason: exitReason,
        holdingDurationMs: Date.now() - position.entryTimestamp,
        orderId: trade.orderId,
        orderStatus: "confirmed",
      });
    }

    // Return filtered list for caller to save
    return filtered;
  }

  try {
    const result = await executeSell({
      chain: CHAIN,
      walletAddress: WALLET_ADDRESS,
      tokenAddress: position.tokenAddress,
      percent: 100, // Sell all
      slippage: SLIPPAGE,
    });

    logger.info(`Sell order submitted for ${position.tokenSymbol}`, {
      orderId: result.order_id,
    });

    // Wait for confirmation (polling logic)
    // Remove position from list immediately
    const positions = await getPositions();
    const filtered = positions.filter(
      (p) => p.tokenAddress !== position.tokenAddress,
    );

    const trade: Trade = {
      id: crypto.randomUUID(),
      tokenAddress: position.tokenAddress,
      tokenSymbol: position.tokenSymbol,
      tokenName: position.tokenName,
      action: "SELL",
      inputAmount: position.amountToken,
      inputAmountSol: position.costSol,
      outputAmount: "0",
      priceAtTrade: position.currentPrice || 0,
      marketCapAtTrade: position.currentMarketCap || 0,
      timestamp: Date.now(),
      orderId: result.order_id,
      orderStatus: "pending",
      isDryRun: false,

      entryPrice: position.entryPrice,
      entryMarketCap: position.entryMarketCap,
      exitPrice: position.currentPrice || 0,
      exitMarketCap: position.currentMarketCap || 0,
      pnlSol: position.unrealizedPnlSol,
      pnlPercent: position.unrealizedPnlPercent,
      holdingDurationMs: Date.now() - position.entryTimestamp,
      exitReason: exitReason as any,

      aiReasoning,
      signalsUsed,
    };

    const trades = await getTrades();
    trades.push(trade);
    await saveTrades(trades);

    // Start polling in background (pass decisionId)
    pollSellOrderConfirmation(position, trade, decisionId);

    // Record sold token for cooldown
    await addSoldToken({
      address: position.tokenAddress,
      symbol: position.tokenSymbol,
    });

    // Return filtered list for caller to save
    return filtered;
  } catch (error) {
    logger.error(`Failed to execute sell for ${position.tokenSymbol}`, {
      error: String(error),
    });
    // Return original positions list (no change) to indicate failure
    const positions = await getPositions();
    return positions;
  }
}

async function pollSellOrderConfirmation(position: Position, trade: Trade, decisionId?: string) {
  const maxWaitTime = 60000; // 60 seconds
  const pollInterval = 3000; // Check every 3 seconds
  const startTime = Date.now();

  logger.info(
    `Starting sell order confirmation polling for ${position.tokenSymbol}`,
    {
      orderId: trade.orderId,
    },
  );

  try {
    while (Date.now() - startTime < maxWaitTime) {
      try {
        await delay(pollInterval);

        const orderStatus = await checkOrderStatus(CHAIN, trade.orderId);

        if (orderStatus.status === "confirmed") {
          // Order confirmed! Update trade and calculate PnL
          logger.info(`Sell order confirmed for ${position.tokenSymbol}`, {
            orderId: trade.orderId,
          });

          const trades = await getTrades();
          const tradeIndex = trades.findIndex((t) => t.id === trade.id);
          if (tradeIndex !== -1 && trades[tradeIndex]) {
            const confirmedTrade = trades[tradeIndex]!;
            confirmedTrade.orderStatus = "confirmed";
            confirmedTrade.exitPrice = position.currentPrice || 0;
            confirmedTrade.exitMarketCap = position.currentMarketCap || 0;
            confirmedTrade.pnlSol = position.unrealizedPnlSol;
            confirmedTrade.pnlPercent = position.unrealizedPnlPercent;
            confirmedTrade.holdingDurationMs =
              Date.now() - position.entryTimestamp;
            confirmedTrade.txHash = orderStatus.tx_hash;

            await saveTrades(trades);
            await updatePerformance();
          }

          // Update decision outcome to success
          if (decisionId) {
            await updateDecisionOutcome(decisionId, "success", {
              pnlSol: position.unrealizedPnlSol,
              pnlPercent: position.unrealizedPnlPercent,
              exitReason: trade.exitReason,
              holdingDurationMs: Date.now() - position.entryTimestamp,
              orderId: trade.orderId,
              orderStatus: "confirmed",
              txHash: orderStatus.tx_hash,
            });
          }
          return;
        } else if (
          orderStatus.status === "failed" ||
          orderStatus.status === "expired"
        ) {
          // Order failed or expired
          logger.warn(
            `Sell order ${orderStatus.status} for ${position.tokenSymbol}`,
            {
              orderId: trade.orderId,
              status: orderStatus.status,
            },
          );

          const trades = await getTrades();
          const tradeIndex = trades.findIndex((t) => t.id === trade.id);
          if (tradeIndex !== -1 && trades[tradeIndex]) {
            trades[tradeIndex]!.orderStatus = orderStatus.status;
            await saveTrades(trades);
          }

          // Update decision outcome to failure
          if (decisionId) {
            await updateDecisionOutcome(decisionId, "failure", {
              exitReason: trade.exitReason,
              orderId: trade.orderId,
              orderStatus: orderStatus.status,
            });
          }
          return;
        }
        // If still pending, continue polling
      } catch (error) {
        logger.error(
          `Error polling sell order status for ${position.tokenSymbol}`,
          {
            orderId: trade.orderId,
            error: String(error),
          },
        );
      }
    }
    // Timeout
    logger.warn(`Sell order polling timeout for ${position.tokenSymbol}`, {
      orderId: trade.orderId,
    });
    const trades = await getTrades();
    const tradeIndex = trades.findIndex((t) => t.id === trade.id);
    if (tradeIndex !== -1 && trades[tradeIndex]) {
      trades[tradeIndex]!.orderStatus = "expired";
      await saveTrades(trades);
    }

    // Update decision outcome to failure (timeout)
    if (decisionId) {
      await updateDecisionOutcome(decisionId, "failure", {
        exitReason: trade.exitReason,
        orderId: trade.orderId,
        orderStatus: "expired",
      });
    }
  } catch (error) {
    logger.error(`Error in sell order polling for ${position.tokenSymbol}`, {
      error: String(error),
    });

    // Update decision outcome to failure (error)
    if (decisionId) {
      await updateDecisionOutcome(decisionId, "failure", {
        exitReason: trade.exitReason,
        orderId: trade.orderId,
        orderStatus: "error",
        error: String(error),
      });
    }
  }
}
