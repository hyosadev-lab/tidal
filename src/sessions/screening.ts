import { fetchTrenchesTokens } from "../gmgn/trenches";
import { getTokenDetails } from "../gmgn/market";
import { executeBuy, checkOrderStatus } from "../gmgn/trade";
import { getBuySkipDecision } from "../agent/decision";
import {
  getPositions,
  savePositions,
  getTrades,
  saveTrades,
  getLearnings,
  getSoldTokens,
  saveSoldTokens,
} from "../storage/db";
import type { Position, Trade, TokenData } from "../storage/types";
import { logger } from "../utils/logger";
import { delay } from "../utils/concurrency";

const CHAIN = process.env.GMGN_CHAIN || "sol";
const WALLET_ADDRESS = process.env.GMGN_WALLET_ADDRESS || "";
const SLIPPAGE = parseFloat(process.env.SLIPPAGE || "0.15");
const MAX_OPEN_POSITIONS = parseInt(process.env.MAX_OPEN_POSITIONS || "5");
const SCAN_INTERVAL_MINUTES = parseFloat(process.env.SCAN_INTERVAL_MINUTES || "0.5");
const SCAN_INTERVAL_MS = SCAN_INTERVAL_MINUTES * 60 * 1000;
const DRY_RUN = process.env.DRY_RUN === "true";
const SOLD_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes cooldown
const AMOUNT_SOL = parseFloat(process.env.AMOUNT_SOL || "0.1");

// Track tokens currently being processed to prevent race conditions
const pendingBuys = new Set<string>();

export async function startScreeningSession() {
  logger.info("Starting screening session");

  await scanAndFilter();

  setInterval(async () => {
    try {
      await scanAndFilter();
    } catch (error) {
      logger.error("Error in screening loop", { error: String(error) });
    }
  }, SCAN_INTERVAL_MS);
}

async function scanAndFilter() {
  logger.debug("Scanning trenches...");

  // 1. Fetch trenches tokens
  const candidates = await fetchTrenchesTokens(CHAIN);

  // 2. Filter client-side (load positions and sold tokens)
  const positions = await getPositions();
  const soldTokens = await getSoldTokens();
  const now = Date.now();

  // Cleanup old sold tokens (older than cooldown)
  const activeSoldTokens = soldTokens.filter(s => now - s.soldAt < SOLD_COOLDOWN_MS);
  if (activeSoldTokens.length !== soldTokens.length) {
    await saveSoldTokens(activeSoldTokens);
  }

  const openPositionAddresses = new Set(positions.map((p) => p.tokenAddress));

  // Filter sold tokens that are still in cooldown period
  const recentSoldAddresses = new Set(activeSoldTokens.map(s => s.address));

  const filteredCandidates = candidates.filter((token) => {
    if (openPositionAddresses.has(token.address)) {
      logger.debug(`Skipping ${token.symbol}: already have position`);
      return false;
    }
    if (recentSoldAddresses.has(token.address)) {
      logger.debug(`Skipping ${token.symbol}: recently sold, in cooldown`);
      return false;
    }
    if (pendingBuys.has(token.address)) {
      logger.debug(`Skipping ${token.symbol}: currently being bought`);
      return false;
    }
    return true;
  });

  logger.info(`Found ${filteredCandidates.length} candidates after filtering`);

  for (const token of filteredCandidates) {
    // Re-check position count from database (to account for pending orders)
    const currentPositions = await getPositions();
    if (currentPositions.length >= MAX_OPEN_POSITIONS) {
      logger.info("Max open positions reached, stopping screening");
      break;
    }

    // Process candidate (bisa diparalelkan jika perlu, tapi sekarang serial dulu)
    await processCandidate(token);

    await delay(500); // Sedikit jeda agar tidak terlalu aggressive
  }
}

async function processCandidate(token: TokenData): Promise<void> {
  try {
    // Fetch detailed data (kline, top traders, price)
    const details = await getTokenDetails(CHAIN, token.address);
    token.kline1mData = details.kline1mData;
    token.kline5mData = details.kline5mData;
    token.topTradersSummary = details.topTradersSummary;
    token.price = details.price;
    token.priceChange1h = details.priceChange1h;
    // Note: volume1h and swaps1h from trenches API are already set
    // If needed, can be overwritten with kline data:
    token.volume1h = details.volume1h;
    token.swaps1h = details.swaps1h;

    // Get learnings (cached atau minimal read)
    const learnings = await getLearnings();

    // AI Decision
    const decision = await getBuySkipDecision(
      token,
      learnings,
    );

    logger.info(
      `Decision for ${token.symbol}: ${decision.action} (${decision.confidence}%)`,
      {
        reasoning: decision.reasoning,
      },
    );

    if (decision.action === "BUY") {
      // Add to pending set to prevent duplicate buys in same scan cycle
      pendingBuys.add(token.address);
      await executeBuyOrder(token);
    }
  } catch (error) {
    logger.error(`Error processing candidate ${token.symbol}`, {
      error: String(error),
    });
  }
}

async function executeBuyOrder(token: TokenData) {
  if (!WALLET_ADDRESS) {
    logger.error("WALLET_ADDRESS not set, cannot execute buy");
    pendingBuys.delete(token.address);
    return;
  }

  if (DRY_RUN) {
    logger.info(`[DRY RUN] Buy ${token.symbol} - ${AMOUNT_SOL} SOL`);

    // Create mock trade and position
    const trade: Trade = {
      id: crypto.randomUUID(),
      tokenAddress: token.address,
      tokenSymbol: token.symbol,
      tokenName: token.name,
      action: "BUY",
      inputAmount: (AMOUNT_SOL * 1e9).toString(),
      inputAmountUsd: AMOUNT_SOL * token.price,
      outputAmount: "0",
      priceAtTrade: token.price,
      marketCapAtTrade: token.usdMarketCap,
      timestamp: Date.now(),
      orderId: "dry-run-" + crypto.randomUUID(),
      orderStatus: "confirmed",
      isDryRun: true,
      aiReasoning: "Dry run buy",
    };

    const position: Position = {
      tokenAddress: token.address,
      tokenSymbol: token.symbol,
      tokenName: token.name,
      entryPrice: token.price,
      entryMarketCap: token.usdMarketCap,
      entryTimestamp: Date.now(),
      amountToken: "0",
      costUsd: AMOUNT_SOL * token.price,
      currentPrice: token.price,
      currentMarketCap: token.usdMarketCap,
      lastUpdated: Date.now(),
      buyTradeId: trade.id,
      smartDegenEntryCount: token.smartDegenCount,
    };

    // Optimized: Load once, modify, save once
    const [trades, positions] = await Promise.all([getTrades(), getPositions()]);
    trades.push(trade);
    positions.push(position);
    await Promise.all([saveTrades(trades), savePositions(positions)]);

    // Clean up pending set for dry run
    pendingBuys.delete(token.address);
    return;
  }

  try {
    const result = await executeBuy({
      chain: CHAIN,
      walletAddress: WALLET_ADDRESS,
      tokenAddress: token.address,
      amountSol: AMOUNT_SOL,
      slippage: SLIPPAGE,
    });

    logger.info(`Buy order submitted for ${token.symbol}`, {
      orderId: result.order_id,
    });

    // Save pending trade
    const trade: Trade = {
      id: crypto.randomUUID(),
      tokenAddress: token.address,
      tokenSymbol: token.symbol,
      tokenName: token.name,
      action: "BUY",
      inputAmount: (AMOUNT_SOL * 1e9).toString(),
      inputAmountUsd: AMOUNT_SOL * token.price,
      outputAmount: "0",
      priceAtTrade: token.price,
      marketCapAtTrade: token.usdMarketCap,
      timestamp: Date.now(),
      orderId: result.order_id,
      orderStatus: "pending",
      isDryRun: false,
    };

    const trades = await getTrades();
    trades.push(trade);
    await saveTrades(trades);

    // Start polling for order confirmation in background
    pollOrderConfirmation(trade, token);
  } catch (error) {
    logger.error(`Failed to execute buy for ${token.symbol}`, {
      error: String(error),
    });
    pendingBuys.delete(token.address);
  }
}

async function pollOrderConfirmation(trade: Trade, token: TokenData) {
  const maxWaitTime = 60000; // 60 seconds
  const pollInterval = 3000; // Check every 3 seconds
  const startTime = Date.now();

  logger.info(`Starting order confirmation polling for ${token.symbol}`, {
    orderId: trade.orderId,
  });

  try {
    while (Date.now() - startTime < maxWaitTime) {
      try {
        await delay(pollInterval);

        const orderStatus = await checkOrderStatus(CHAIN, trade.orderId);

        if (orderStatus.status === "confirmed") {
          // Order confirmed! Create position and update trade
          logger.info(`Order confirmed for ${token.symbol}`, {
            orderId: trade.orderId,
          });

          // Update trade status
          const trades = await getTrades();
          const tradeIndex = trades.findIndex((t) => t.id === trade.id);
          if (tradeIndex !== -1 && trades[tradeIndex]) {
            trades[tradeIndex]!.orderStatus = "confirmed";
            trades[tradeIndex]!.aiReasoning = "Order confirmed by GMGN";
            await saveTrades(trades);

            // Create position
            const position: Position = {
              tokenAddress: token.address,
              tokenSymbol: token.symbol,
              tokenName: token.name,
              entryPrice: token.price,
              entryMarketCap: token.usdMarketCap,
              entryTimestamp: Date.now(),
              amountToken: orderStatus.output_amount?.toString() || "0",
              costUsd: parseFloat(trade.inputAmountUsd.toString()),
              currentPrice: token.price,
              currentMarketCap: token.usdMarketCap,
              lastUpdated: Date.now(),
              buyTradeId: trade.id,
              smartDegenEntryCount: token.smartDegenCount,
            };

            const positions = await getPositions();
            positions.push(position);
            await savePositions(positions);

            logger.info(`Position created for ${token.symbol}`, {
              costUsd: position.costUsd,
            });
          }
          return;
        } else if (orderStatus.status === "failed" || orderStatus.status === "expired") {
          // Order failed or expired
          logger.warn(`Order ${orderStatus.status} for ${token.symbol}`, {
            orderId: trade.orderId,
            status: orderStatus.status,
          });

          const trades = await getTrades();
          const tradeIndex = trades.findIndex((t) => t.id === trade.id);
          if (tradeIndex !== -1 && trades[tradeIndex]) {
            trades[tradeIndex]!.orderStatus = orderStatus.status;
            await saveTrades(trades);
          }
          return;
        }
        // If still pending, continue polling
      } catch (error) {
        logger.error(`Error polling order status for ${token.symbol}`, {
          orderId: trade.orderId,
          error: String(error),
        });
      }
    }

    // Timeout reached
    logger.warn(`Order confirmation timeout for ${token.symbol}`, {
      orderId: trade.orderId,
      waitTime: maxWaitTime,
    });

    const trades = await getTrades();
    const tradeIndex = trades.findIndex((t) => t.id === trade.id);
    if (tradeIndex !== -1 && trades[tradeIndex]) {
      trades[tradeIndex]!.orderStatus = "expired";
      await saveTrades(trades);
    }
  } finally {
    // Always remove from pending set when done
    pendingBuys.delete(token.address);
  }
}
