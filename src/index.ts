import { getConfig } from './config.ts';
import { getDb } from './db/database.ts';
import { logger } from './utils/logger.ts';
import { mkdirSync } from 'fs';

async function main(): Promise<void> {
  // Ensure log directory exists
  mkdirSync('logs', { recursive: true });

  // Load and validate config (will exit if invalid)
  const config = getConfig();

  logger.info('agent_starting', {
    dryRun: config.dryRun,
    model: config.openrouterModel,
    tradeSizeSol: config.tradeSizeSol,
    maxConcurrentPositions: config.maxConcurrentPositions,
    trailingActivatePct: config.trailingActivatePct,
    trailingDrawdownPct: config.trailingDrawdownPct,
    stopLossPct: config.stopLossPct,
  });

  // Initialize DB
  getDb();

  logger.info('phase1_complete', {
    message: 'Foundation ready. Implement Phase 2 next.',
  });
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
