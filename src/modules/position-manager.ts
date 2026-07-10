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
  updatePeakPrice,
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
  // if (config.dryRun) return true;

  if (config.aiEvaluation) return true;

  // Both sides covered by condition orders
  if (hasTrailing && hasSl) return false;

  // At least one side not covered → AI needed
  return true;
}

/**
 * Mirror GMGN condition orders client-side.
 *
 * Since GMGN does not return strategy_order_id in swap response,
 * we cannot poll condition order status via API.
 * Instead we track price movement and mirror the same logic:
 *   - loss_stop:        close if price drops >= STOP_LOSS_PCT from entry
 *   - profit_stop_trace: close if price drops >= TRAILING_DRAWDOWN_PCT from peak,
 *                        but only after price has risen >= TRAILING_ACTIVATE_PCT from entry
 */
function checkConditionOrderMirror(
  position: Position,
  currentPrice: number
): { triggered: boolean; reason: string } {
  const config = getConfig();

  // Mirror loss_stop
  if (config.stopLossPct) {
    const slThreshold = position.entry_price_usd * (1 - config.stopLossPct / 100);
    if (currentPrice <= slThreshold) {
      return { triggered: true, reason: 'STOP_LOSS' };
    }
  }

  // Mirror profit_stop_trace
  if (config.trailingActivatePct && config.trailingDrawdownPct) {
    const peakPrice = position.peak_price_usd ?? position.entry_price_usd;
    const activateThreshold = position.entry_price_usd * (1 + config.trailingActivatePct / 100);

    // Only check trailing if peak has reached activation threshold
    if (peakPrice >= activateThreshold) {
      const trailingThreshold = peakPrice * (1 - config.trailingDrawdownPct / 100);
      if (currentPrice <= trailingThreshold) {
        return { triggered: true, reason: 'TRAILING_STOP' };
      }
    }
  }

  return { triggered: false, reason: '' };
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

  // 1. Fetch current token info — needed for all checks below
  let info;
  try {
    info = await client.getTokenInfo(position.mint_address);
  } catch (err) {
    logger.warn('position_info_fetch_failed', { mint: position.mint_address, error: String(err) });
    return;
  }

  const currentPrice = parseFloat(info.price.price);

  // 2. Update peak price in DB if current price is higher
  if (currentPrice > (position.peak_price_usd ?? position.entry_price_usd)) {
    updatePeakPrice(position.mint_address, currentPrice);
    // Update local reference for condition mirror check below
    position.peak_price_usd = currentPrice;
  }

  // 3. Mirror condition orders (loss_stop + profit_stop_trace)
  //    This keeps DB in sync with what GMGN condition orders would do on-chain
  const mirror = checkConditionOrderMirror(position, currentPrice);
  if (mirror.triggered) {
    logger.info('condition_order_mirror_triggered', {
      mint: position.mint_address,
      symbol: position.symbol,
      reason: mirror.reason,
      current_price: currentPrice,
      entry_price: position.entry_price_usd,
      peak_price: position.peak_price_usd,
    });

    // In live mode: condition order sudah fire on-chain. Coba query harga
    // fill ASLI dari GMGN (bukan cuma sinkronisasi DB pakai harga polling),
    // karena kita cuma tahu "sudah closed" lewat polling — bukan lewat
    // notifikasi instan — jadi currentPrice yang kita pegang bisa sudah jauh
    // meleset dari harga fill sesungguhnya di token yang sangat volatile.
    // Approximation tetap dipakai sebagai fallback kalau:
    //   (a) dry-run — tidak pernah ada strategy order sungguhan untuk di-query
    //   (b) live tapi order belum muncul 'closed' di GMGN saat kita query
    //       (race condition — sistem GMGN belum selesai proses)
    let exitPriceUsd = currentPrice;
    let solReceived = position.sol_invested * (currentPrice / position.entry_price_usd);
    let exitHandler = config.dryRun ? 'condition_order_simulated' : 'condition_order_live_no_order';
    let usedRealFill = false;

    if (!config.dryRun && !position.strategy_order_id) {
      // Live tapi tidak pernah punya strategy_order_id sama sekali — berarti
      // condition order gagal ter-attach saat buy (lihat log
      // 'condition_order_not_attached' di executor.ts). Posisi ini tidak
      // pernah punya proteksi on-chain, dan real-fill-price query di bawah
      // tidak mungkin dicoba karena tidak ada order_id untuk di-query.
      logger.error('mirror_exit_no_strategy_order', {
        mint: position.mint_address,
        note: 'Posisi tidak punya strategy_order_id — exit ini murni dari polling mirror check, sama seperti dry-run. Kemungkinan overshoot dari threshold yang dikonfigurasi.',
      });
    }

    if (!config.dryRun && position.strategy_order_id) {
      try {
        const client = getGmgnClient();
        const history = await client.getStrategyOrderHistory(position.mint_address, 10);
        const match = history.find(
          (o) => o.order_id === position.strategy_order_id && o.status === 'closed' && o.close_price
        );

        if (match) {
          const realClosePrice = parseFloat(match.close_price);
          if (realClosePrice > 0) {
            exitPriceUsd = realClosePrice;
            solReceived = position.sol_invested * (realClosePrice / position.entry_price_usd);
            usedRealFill = true;
          }
        }
      } catch (err) {
        logger.warn('strategy_order_fill_query_failed', {
          mint: position.mint_address,
          strategy_order_id: position.strategy_order_id,
          error: String(err),
        });
        // fall through — tetap pakai approximation
      }

      if (usedRealFill) {
        exitHandler = 'condition_order_live_confirmed';
      } else {
        exitHandler = 'condition_order_live_approximated';
        logger.warn('strategy_order_fill_not_found_yet', {
          mint: position.mint_address,
          strategy_order_id: position.strategy_order_id,
          note: 'menggunakan approximation currentPrice sebagai fallback',
        });
      }
    }

    await handlePositionClose({
      position,
      exitPriceUsd,
      solReceived,
      exitReason: mirror.reason,
      exitHandler,
      solPriceUsd,
    });
    return;
  }

  // 4. Check time limit (always active)
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
      entryPriceUsd: position.entry_price_usd,
      solInvested: position.sol_invested,
      currentPriceUsd: currentPrice,
    });

    if (result.success) {
      const priceUsd = result.priceUsd ?? currentPrice;
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

  // 5. AI evaluation (only if at least one side not covered by condition orders)
  if (!needsAiEvaluation(position)) return;

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
      entryPriceUsd: position.entry_price_usd,
      solInvested: position.sol_invested,
      currentPriceUsd: snap.price,
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
