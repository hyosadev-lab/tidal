import { getGmgnClient } from '../services/gmgn-client.ts';
import { getConfig } from '../config.ts';
import { logger } from '../utils/logger.ts';
import {
  getOpenPositions,
  closePosition,
  insertAiDecision,
  upsertDailyStats,
  getBestAndWorstTrades,
  getDailyStats,
  type Position,
} from '../db/queries.ts';
import { buildPositionSnapshot, buildPositionPrompt } from './ai-decision.ts';
import { evaluatePosition } from '../services/openrouter.ts';
import { executeSell } from './executor.ts';
import { computePnlPct, minutesSince, formatUsd, formatPct } from '../utils/math.ts';
import { logDailySummary } from '../utils/logger.ts';
import { getSolPriceUsd } from '../services/coingecko.ts';

/**
 * Determine if this position needs AI evaluation based on exit config.
 * AI is needed if at least one side (upside or downside) is NOT covered by condition orders.
 */
function needsAiEvaluation(position: Position): boolean {
  const config = getConfig();
  const hasTrailing = !!(config.trailingActivatePct && config.trailingDrawdownPct);
  const hasSl = !!config.stopLossPct;

  // DRY_RUN positions have no condition orders
  if (config.dryRun) return true;

  // Both sides covered by condition orders
  if (hasTrailing && hasSl) return false;

  // At least one side not covered → AI needed
  return true;
}

/**
 * Check if condition order has fired (position closed on-chain).
 * Only relevant for live mode where strategy_order_id exists.
 */
async function checkConditionOrderFired(position: Position): Promise<{
  fired: boolean;
  priceUsd?: number;
  solReceived?: number;
}> {
  const config = getConfig();

  if (config.dryRun || !position.strategy_order_id) {
    return { fired: false };
  }

  const client = getGmgnClient();
  try {
    const status = await client.queryOrder(position.strategy_order_id);
    if (status.status === 'confirmed' || status.status === 'successful') {
      const report = status.report;
      return {
        fired: true,
        priceUsd: report ? parseFloat(report.price_usd) : undefined,
        solReceived: report
          ? Number(report.output_amount) / Math.pow(10, report.output_token_decimals)
          : undefined,
      };
    }
  } catch (err) {
    logger.warn('condition_order_check_failed', {
      mint: position.mint_address,
      error: String(err),
    });
  }

  return { fired: false };
}

/**
 * Handle closing a position — record in DB, update daily stats, log.
 */
async function handlePositionClose(params: {
  position: Position;
  exitPriceUsd: number;
  solReceived: number;
  exitReason: string;
  exitHandler: string;
  solPriceUsd: number;
}): Promise<void> {
  const { position, exitPriceUsd, solReceived, exitReason, exitHandler, solPriceUsd } = params;

  const pnlPct = computePnlPct(position.entry_price_usd, exitPriceUsd);
  const pnlUsd = (solReceived - position.sol_invested) * solPriceUsd;
  const won = pnlUsd > 0;

  closePosition({
    mintAddress: position.mint_address,
    exitPriceUsd,
    solReturned: solReceived,
    pnlUsd,
    pnlPct,
    exitReason,
    exitHandler,
  });

  const today = new Date().toISOString().slice(0, 10);
  upsertDailyStats(today, pnlUsd, position.sol_invested, won);

  logger.info('position_closed', {
    mint: position.mint_address,
    symbol: position.symbol,
    exit_reason: exitReason,
    exit_handler: exitHandler,
    pnl_usd: formatUsd(pnlUsd),
    pnl_pct: formatPct(pnlPct),
    hold_minutes: minutesSince(position.opened_at).toFixed(0),
  });
}

/**
 * Main position manager loop — called every POSITION_CHECK_INTERVAL_SEC.
 */
export async function checkOpenPositions(): Promise<void> {
  const positions = getOpenPositions();

  if (positions.length === 0) return;

  const solPriceUsd = await getSolPriceUsd();

  for (const position of positions) {
    try {
      await processPosition(position, solPriceUsd);
    } catch (err) {
      logger.error('position_check_error', {
        mint: position.mint_address,
        error: String(err),
      });
    }
  }
}

async function processPosition(position: Position, solPriceUsd: number): Promise<void> {
  const config = getConfig();
  const client = getGmgnClient();

  // 1. Check if condition order already fired (live mode only)
  const conditionFired = await checkConditionOrderFired(position);
  if (conditionFired.fired) {
    const exitPriceUsd = conditionFired.priceUsd ?? position.entry_price_usd;
    const solReceived = conditionFired.solReceived ?? position.sol_invested;
    await handlePositionClose({
      position,
      exitPriceUsd,
      solReceived,
      exitReason: 'CONDITION_ORDER',
      exitHandler: 'condition_order',
      solPriceUsd,
    });
    return;
  }

  // 2. Check time limit (always active)
  const holdMinutes = minutesSince(position.opened_at);
  if (holdMinutes >= config.maxHoldDurationMinutes) {
    logger.info('time_limit_reached', {
      mint: position.mint_address,
      symbol: position.symbol,
      hold_minutes: holdMinutes.toFixed(0),
    });

    const result = await executeSell({
      mintAddress: position.mint_address,
      symbol: position.symbol,
      tokenAmount: position.token_amount,
      strategyOrderId: position.strategy_order_id,
      reason: 'TIME_LIMIT',
    });

    if (result.success) {
      // Fetch current price as fallback if sell didn't return price
      const priceUsd = result.priceUsd ?? position.entry_price_usd;
      const solReceived = result.solReceived ?? position.sol_invested;

      await handlePositionClose({
        position,
        exitPriceUsd: priceUsd,
        solReceived,
        exitReason: 'TIME_LIMIT',
        exitHandler: 'time_limit',
        solPriceUsd,
      });
    }
    return;
  }

  // 3. AI evaluation (if needed based on exit config)
  if (!needsAiEvaluation(position)) return;

  // Fetch current token info
  let info;
  try {
    info = await client.getTokenInfo(position.mint_address);
  } catch (err) {
    logger.warn('position_info_fetch_failed', { mint: position.mint_address, error: String(err) });
    return;
  }

  const snap = buildPositionSnapshot(position, info, solPriceUsd);
  const prompt = buildPositionPrompt(position, snap);
  const decision = await evaluatePosition(prompt);

  insertAiDecision({
    mintAddress: position.mint_address,
    decisionType: 'position',
    action: decision.action,
    confidence: decision.confidence,
    reasoning: decision.reasoning,
    rawResponse: (decision as any)._raw ?? '',
  });

  logger.info('ai_position_decision', {
    mint: position.mint_address,
    symbol: position.symbol,
    action: decision.action,
    confidence: decision.confidence,
    pnl_pct: formatPct(snap.pnlPct),
    reasoning: decision.reasoning,
  });

  if (decision.action === 'SELL' && decision.confidence >= config.aiConfidenceThreshold) {
    const result = await executeSell({
      mintAddress: position.mint_address,
      symbol: position.symbol,
      tokenAmount: position.token_amount,
      strategyOrderId: position.strategy_order_id,
      reason: 'AI_SELL',
    });

    if (result.success) {
      const priceUsd = result.priceUsd ?? snap.price;
      const solReceived = result.solReceived ?? position.sol_invested;
      await handlePositionClose({
        position,
        exitPriceUsd: priceUsd,
        solReceived,
        exitReason: 'AI_SELL',
        exitHandler: 'ai',
        solPriceUsd,
      });
    }
  }
}

/**
 * Print daily summary — call at midnight or on agent shutdown.
 */
export function printDailySummary(): void {
  const today = new Date().toISOString().slice(0, 10);
  const stats = getDailyStats(today) as any;
  if (!stats) return;

  const { best, worst } = getBestAndWorstTrades(today);

  logDailySummary({
    date: today,
    tradesTotal: stats.trades_total,
    tradesWon: stats.trades_won,
    tradesLost: stats.trades_lost,
    pnlUsd: stats.pnl_usd,
    winRate: stats.win_rate,
    avgPnlPerTrade: stats.avg_pnl_per_trade,
    bestTrade: best ?? undefined,
    worstTrade: worst ?? undefined,
  });
}
