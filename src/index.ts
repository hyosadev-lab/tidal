import { getConfig } from './config.ts';
import { getDb } from './db/database.ts';
import { logger } from './utils/logger.ts';
import { scanGraduatedTokens } from './modules/scanner.ts';
import { enrichAndScore, buildEntryPrompt } from './modules/scorer.ts';
import { evaluateEntry } from './services/openrouter.ts';
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
  });

  getDb();

  logger.info('scanner_loop_starting', { intervalSec: config.scanIntervalSec });

  // Main scan loop
  while (true) {
    try {
      await scanCycle();
    } catch (err) {
      logger.error('scan_cycle_error', { error: String(err) });
    }

    await sleep(config.scanIntervalSec * 1000);
  }
}

async function scanCycle(): Promise<void> {
  const config = getConfig();

  // 1. Scan for new graduated tokens
  const candidates = await scanGraduatedTokens();

  // 2. Evaluate max 2 candidates per cycle (rate limit budget)
  const toEvaluate = candidates.slice(0, 2);

  for (const token of toEvaluate) {
    logger.info('evaluating_candidate', { mint: token.address, symbol: token.symbol });

    // 3. Enrich data + score
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

    // 5. Ready to BUY — executor will handle this in Phase 4
    logger.info('buy_signal', {
      mint: token.address,
      symbol: token.symbol,
      composite: enriched.scores.composite.toFixed(1),
      confidence: decision.confidence,
      dryRun: config.dryRun,
      message: 'Executor not yet implemented (Phase 4)',
    });

    updateTokenStatus(token.address, 'skipped'); // temporary until Phase 4
  }
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
