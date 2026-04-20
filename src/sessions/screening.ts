import { fetchTrenchesTokens } from "../gmgn/trenches";
import { getTokenDetails } from "../gmgn/market";
import { executeBuy } from "../gmgn/trade";
import { getBuySkipDecision } from "../agent/decision";
import {
  getPositions,
  savePositions,
  getTrades,
  saveTrades,
  getLearnings,
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

  // 2. Filter client-side
  const positions = await getPositions();
  const openPositionsCount = positions.length;
  const openPositionAddresses = new Set(positions.map((p) => p.tokenAddress));

  const filteredCandidates = candidates.filter((token) => {
    if (openPositionAddresses.has(token.address)) {
      logger.debug(`Skipping ${token.symbol}: already have position`);
      return false;
    }
    return true;
  });

  logger.info(`Found ${filteredCandidates.length} candidates after filtering`);

  // 3. Process each candidate
  for (const token of filteredCandidates) {
    if (openPositionsCount >= MAX_OPEN_POSITIONS) {
      logger.info("Max open positions reached, stopping screening");
      break;
    }

    await processCandidate(token, openPositionsCount);

    await delay(1000);
  }
}

async function processCandidate(token: TokenData, currentOpenCount: number) {
  try {
    // Fetch detailed data (kline, top traders)
    const details = await getTokenDetails(CHAIN, token.address);
    token.klineData = details.klineData;
    token.topTradersSummary = details.topTradersSummary;

    // Get learnings
    const learnings = await getLearnings();

    // AI Decision
    const decision = await getBuySkipDecision(
      token,
      currentOpenCount,
      MAX_OPEN_POSITIONS,
      learnings,
    );

    logger.info(
      `Decision for ${token.symbol}: ${decision.action} (${decision.confidence}%)`,
      {
        reasoning: decision.reasoning,
      },
    );

    if (decision.action === "BUY") {
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
    return;
  }

  const amountSol = 0.01; // Fixed amount for demo, should be calculated based on balance/risk

  if (DRY_RUN) {
    logger.info(`[DRY RUN] Buy ${token.symbol} - ${amountSol} SOL`);

    // Create mock trade and position
    const trade: Trade = {
      id: crypto.randomUUID(),
      tokenAddress: token.address,
      tokenSymbol: token.symbol,
      tokenName: token.name,
      action: "BUY",
      inputAmount: (amountSol * 1e9).toString(),
      inputAmountUsd: amountSol * token.price, // Approximate
      outputAmount: "0", // Unknown amount received
      priceAtTrade: token.price,
      marketCapAtTrade: token.marketCap,
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
      entryMarketCap: token.marketCap,
      entryTimestamp: Date.now(),
      amountToken: "0", // Unknown in dry run
      costUsd: amountSol * token.price, // Approximate
      currentPrice: token.price,
      currentMarketCap: token.marketCap,
      lastUpdated: Date.now(),
      buyTradeId: trade.id,
    };

    const trades = await getTrades();
    trades.push(trade);
    await saveTrades(trades);

    const positions = await getPositions();
    positions.push(position);
    await savePositions(positions);

    return;
  }

  try {
    const result = await executeBuy({
      chain: CHAIN,
      walletAddress: WALLET_ADDRESS,
      tokenAddress: token.address,
      amountSol: amountSol,
      slippage: SLIPPAGE,
    });

    logger.info(`Buy order submitted for ${token.symbol}`, {
      orderId: result.order_id,
    });

    // Wait for order confirmation (polling logic would go here)
    // For simplicity, we just log and save pending trade
    const trade: Trade = {
      id: crypto.randomUUID(),
      tokenAddress: token.address,
      tokenSymbol: token.symbol,
      tokenName: token.name,
      action: "BUY",
      inputAmount: (amountSol * 1e9).toString(),
      inputAmountUsd: amountSol * token.price,
      outputAmount: "0",
      priceAtTrade: token.price,
      marketCapAtTrade: token.marketCap,
      timestamp: Date.now(),
      orderId: result.order_id,
      orderStatus: "pending",
      isDryRun: false,
    };

    const trades = await getTrades();
    trades.push(trade);
    await saveTrades(trades);
  } catch (error) {
    logger.error(`Failed to execute buy for ${token.symbol}`, {
      error: String(error),
    });
  }
}
