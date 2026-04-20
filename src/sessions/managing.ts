import { getPositions, savePositions, getTrades, saveTrades, getLearnings } from "../storage/db";
import { getTokenDetails } from "../gmgn/market";
import { executeSell, checkOrderStatus } from "../gmgn/trade";
import { getManageDecision, checkHardRules } from "../agent/manager";
import type { Position, Trade, TokenData } from "../storage/types";
import { logger } from "../utils/logger";

const CHAIN = process.env.GMGN_CHAIN || "sol";
const WALLET_ADDRESS = process.env.GMGN_WALLET_ADDRESS || "";
const SLIPPAGE = parseFloat(process.env.SLIPPAGE || "0.15");
const TAKE_PROFIT_PERCENT = parseInt(process.env.TAKE_PROFIT_PERCENT || "50");
const STOP_LOSS_PERCENT = parseInt(process.env.STOP_LOSS_PERCENT || "30");
const MANAGE_INTERVAL_MINUTES = parseFloat(process.env.MANAGE_INTERVAL_MINUTES || "0.1667");
const MANAGE_INTERVAL_MS = MANAGE_INTERVAL_MINUTES * 60 * 1000;
const DRY_RUN = process.env.DRY_RUN === "true";

export async function startManagingSession() {
  logger.info("Starting managing session");

  setInterval(async () => {
    try {
      await monitorPositions();
    } catch (error) {
      logger.error("Error in managing loop", { error: String(error) });
    }
  }, MANAGE_INTERVAL_MS);
}

async function monitorPositions() {
  const positions = await getPositions();

  if (positions.length === 0) {
    logger.debug("No open positions to monitor");
    return;
  }

  logger.debug(`Monitoring ${positions.length} positions`);

  for (const position of positions) {
    await processPosition(position);
  }

  // Learn from recent trades periodically
  const trades = await getTrades();
  const confirmedTrades = trades.filter(t => t.orderStatus === "confirmed");
  if (confirmedTrades.length % 5 === 0 && confirmedTrades.length > 0) {
     // In a real app, we'd call generateLearnings() here
     // await generateLearnings();
  }
}

async function processPosition(position: Position) {
  try {
    // 1. Fetch current price
    const details = await getTokenDetails(CHAIN, position.tokenAddress);
    const currentPrice = parseFloat(details.kline1mData.split("\n").pop()?.split("C:")[1]?.split(" ")[0] || "0");

    // Update position PnL
    position.currentPrice = currentPrice;
    position.currentMarketCap = position.entryMarketCap * (currentPrice / position.entryPrice); // Approximate
    position.unrealizedPnlUsd = (currentPrice - position.entryPrice) * parseFloat(position.amountToken); // Simplified
    position.unrealizedPnlPercent = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
    position.lastUpdated = Date.now();

    // 2. Check hard rules
    const hardRule = checkHardRules(position, TAKE_PROFIT_PERCENT, STOP_LOSS_PERCENT);
    if (hardRule) {
      logger.info(`Hard rule triggered for ${position.tokenSymbol}: ${hardRule}`);
      await executeSellOrder(position, hardRule);
      return;
    }

    // 3. AI Decision
    const learnings = await getLearnings();
    const tokenData: TokenData = {
      address: position.tokenAddress,
      symbol: position.tokenSymbol,
      name: position.tokenName,
      price: currentPrice,
      marketCap: position.currentMarketCap || 0,
      kline1mData: details.kline1mData,
      kline5mData: details.kline5mData,
      topTradersSummary: details.topTradersSummary,
      // Fill required fields with defaults or current data
      liquidity: 0, volume1h: 0, volume24h: 0, swaps1h: 0, swaps24h: 0,
      buys24h: 0, sells24h: 0, change1h: 0, holderCount: 0,
      smartDegenCount: 0, renownedCount: 0, top10HolderRate: 0,
      creatorTokenStatus: "", creatorBalanceRate: 0, rugRatio: 0,
      bundlerRate: 0, insiderRatio: 0, isWashTrading: false,
      launchpadPlatform: "", renouncedMint: false, renouncedFreezeAccount: false,
      hasAtLeastOneSocial: false, ctoFlag: false,
    };

    const decision = await getManageDecision(position, tokenData, TAKE_PROFIT_PERCENT, STOP_LOSS_PERCENT, learnings);

    if (decision.action === "SELL") {
      logger.info(`AI decision to SELL ${position.tokenSymbol}: ${decision.reasoning}`);
      await executeSellOrder(position, "ai_decision");
    } else {
      // Just update position in DB
      const positions = await getPositions();
      const idx = positions.findIndex(p => p.tokenAddress === position.tokenAddress);
      if (idx !== -1) positions[idx] = position;
      await savePositions(positions);
    }

  } catch (error) {
    logger.error(`Error processing position ${position.tokenSymbol}`, { error: String(error) });
  }
}

async function executeSellOrder(position: Position, reason: string) {
  if (!WALLET_ADDRESS) {
    logger.error("WALLET_ADDRESS not set, cannot execute sell");
    return;
  }

  if (DRY_RUN) {
    logger.info(`[DRY RUN] Sell ${position.tokenSymbol} - Reason: ${reason}`);

    // Update position as sold
    const positions = await getPositions();
    const filtered = positions.filter(p => p.tokenAddress !== position.tokenAddress);
    await savePositions(filtered);

    // Add to trades history
    const trade: Trade = {
      id: crypto.randomUUID(),
      tokenAddress: position.tokenAddress,
      tokenSymbol: position.tokenSymbol,
      tokenName: position.tokenName,
      action: "SELL",
      inputAmount: position.amountToken,
      inputAmountUsd: position.costUsd,
      outputAmount: "0",
      priceAtTrade: position.currentPrice || 0,
      marketCapAtTrade: position.currentMarketCap || 0,
      timestamp: Date.now(),
      orderId: "dry-run-" + crypto.randomUUID(),
      orderStatus: "confirmed",
      isDryRun: true,
      entryPrice: position.entryPrice,
      exitPrice: position.currentPrice,
      pnlUsd: position.unrealizedPnlUsd,
      pnlPercent: position.unrealizedPnlPercent,
      holdingDurationMs: Date.now() - position.entryTimestamp,
      exitReason: reason as any,
    };

    const trades = await getTrades();
    trades.push(trade);
    await saveTrades(trades);
    return;
  }

  try {
    const result = await executeSell({
      chain: CHAIN,
      walletAddress: WALLET_ADDRESS,
      tokenAddress: position.tokenAddress,
      percent: 100, // Sell all
      slippage: SLIPPAGE,
    });

    logger.info(`Sell order submitted for ${position.tokenSymbol}`, { orderId: result.order_id });

    // Wait for confirmation (polling logic)
    // For now, just mark position as pending sell or remove it?
    // We'll remove it from positions and add pending trade
    const positions = await getPositions();
    const filtered = positions.filter(p => p.tokenAddress !== position.tokenAddress);
    await savePositions(filtered);

    const trade: Trade = {
      id: crypto.randomUUID(),
      tokenAddress: position.tokenAddress,
      tokenSymbol: position.tokenSymbol,
      tokenName: position.tokenName,
      action: "SELL",
      inputAmount: position.amountToken,
      inputAmountUsd: position.costUsd,
      outputAmount: "0",
      priceAtTrade: position.currentPrice || 0,
      marketCapAtTrade: position.currentMarketCap || 0,
      timestamp: Date.now(),
      orderId: result.order_id,
      orderStatus: "pending",
      isDryRun: false,
      entryPrice: position.entryPrice,
      exitReason: reason as any,
    };

    const trades = await getTrades();
    trades.push(trade);
    await saveTrades(trades);

  } catch (error) {
    logger.error(`Failed to execute sell for ${position.tokenSymbol}`, { error: String(error) });
  }
}
