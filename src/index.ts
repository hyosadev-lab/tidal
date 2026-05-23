import { getConfig } from './config.ts';
import { getDb } from './db/database.ts';
import { logger } from './utils/logger.ts';
import { scanGraduatedTokens } from './modules/scanner.ts';
import { enrichAndScore, buildEntryPrompt } from './modules/scorer.ts';
import { evaluateEntry } from './services/openrouter.ts';
import { canOpenPosition, executeBuy } from './modules/executor.ts';
import { checkOpenPositions, printDailySummary } from './modules/position-manager.ts';
import { insertAiDecision, updateTokenStatus } from './db/queries.ts';
import { mkdirSync } from 'fs';
import { sleep } from './utils/retry.ts';

async function main(): Promise<void> {
  mkdirSync('logs', { recursive: true });

  const config = getConfig();

  logger.info('agent_starting', {
    dryRun: config.dryRun,
    model: config.openrouterModel,
    tradeSizeSol: config.tradeSizeSol,
    maxConcurrentPositions: config.maxConcurrentPositions,
    minScoreToBuy: config.minScoreToBuy,
    klineResolution: config.klineResolution,
    trailingActivatePct: config.trailingActivatePct,
    trailingDrawdownPct: config.trailingDrawdownPct,
    stopLossPct: config.stopLossPct,
    scanIntervalSec: config.scanIntervalSec,
    positionCheckIntervalSec: config.positionCheckIntervalSec,
  });

  getDb();

  // Graceful shutdown
  process.on('SIGINT', () => {
    logger.info('agent_shutting_down');
    printDailySummary();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    logger.info('agent_shutting_down');
    printDailySummary();
    process.exit(0);
  });

  // Schedule daily summary at midnight
  scheduleDailySummary();

  // Run both loops concurrently
  await Promise.all([
    scanLoop(),
    positionLoop(),
  ]);
}

async function scanLoop(): Promise<void> {
  const config = getConfig();
  logger.info('scan_loop_started', { intervalSec: config.scanIntervalSec });

  while (true) {
    try {
      await scanCycle();
    } catch (err) {
      logger.error('scan_cycle_error', { error: String(err) });
    }
    await sleep(config.scanIntervalSec * 1000);
  }
}

async function positionLoop(): Promise<void> {
  const config = getConfig();
  logger.info('position_loop_started', { intervalSec: config.positionCheckIntervalSec });

  while (true) {
    try {
      await checkOpenPositions();
    } catch (err) {
      logger.error('position_loop_error', { error: String(err) });
    }
    await sleep(config.positionCheckIntervalSec * 1000);
  }
}

async function scanCycle(): Promise<void> {
  const config = getConfig();

  // 1. Scan
  const candidates = await scanGraduatedTokens();

  // 2. Evaluate max 2 per cycle (rate limit budget)
  // const toEvaluate = candidates.slice(0, 2);
  const toEvaluate = candidates

  for (const token of toEvaluate) {
    logger.info('evaluating_candidate', { mint: token.address, symbol: token.symbol });

    // 3. Enrich + score
    const enriched = await enrichAndScore(token);
    if (!enriched) {
      updateTokenStatus(token.address, 'skipped');
      continue;
    }

    // 4. AI entry decision
    const prompt = buildEntryPrompt(enriched);
    const decision = await evaluateEntry(prompt);

    insertAiDecision({
      mintAddress: token.address,
      decisionType: 'entry',
      action: decision.action,
      confidence: decision.confidence,
      reasoning: decision.reasoning,
      redFlags: decision.red_flags,
      rawResponse: (decision as any)._raw ?? '',
    });

    logger.info('ai_entry_decision', {
      mint: token.address,
      symbol: token.symbol,
      action: decision.action,
      confidence: decision.confidence,
      red_flags: decision.red_flags,
    });

    if (decision.action !== 'BUY' || decision.confidence < config.aiConfidenceThreshold) {
      updateTokenStatus(token.address, 'skipped');
      continue;
    }

    // 5. Position gate
    if (!canOpenPosition()) {
      logger.warn('buy_skipped_position_full', { mint: token.address, symbol: token.symbol });
      updateTokenStatus(token.address, 'skipped');
      continue;
    }

    // 6. Execute buy
    const bought = await executeBuy(enriched);
    if (!bought) {
      updateTokenStatus(token.address, 'error');
    }
  }
}

function scheduleDailySummary(): void {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  const msUntilMidnight = midnight.getTime() - now.getTime();

  setTimeout(() => {
    printDailySummary();
    // Re-schedule for next midnight
    setInterval(() => printDailySummary(), 24 * 60 * 60 * 1000);
  }, msUntilMidnight);
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
