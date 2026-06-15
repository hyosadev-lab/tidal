import { getGmgnClient, type TrenchesToken } from '../services/gmgn-client.ts';
import { shouldSkipToken } from '../db/queries.ts';
import { logger } from '../utils/logger.ts';

export type { TrenchesToken };

export async function scanGraduatedTokens(): Promise<TrenchesToken[]> {
  const client = getGmgnClient();

  let tokens: TrenchesToken[];
  try {
    tokens = await client.getGraduatedTokens();
  } catch (err) {
    logger.error('scan_failed', { error: String(err) });
    return [];
  }

  const passed: TrenchesToken[] = [];
  let skippedDedup = 0;
  let skippedClientFilter = 0;

  for (const token of tokens) {
    // Dedup: skip if already in positions or active trades
    if (shouldSkipToken(token.address)) {
      skippedDedup++;
      continue;
    }

    // Client-side filter
    if (!passesClientFilter(token)) {
      skippedClientFilter++;
      continue;
    }

    passed.push(token);
  }

  logger.info('scan_complete', {
    total: tokens.length,
    passed: passed.length,
    skipped_dedup: skippedDedup,
    skipped_client_filter: skippedClientFilter,
  });

  return passed;
}

function passesClientFilter(token: TrenchesToken): boolean {
  if (token.owner_renounced === 'no') {
    logger.warn('token_skipped', { mint: token.address, symbol: token.symbol, reason: 'owner_not_renounced' });
    return false;
  }
  // if (token.creator_token_status === 'creator_hold') {
  //   logger.warn('token_skipped', { mint: token.address, symbol: token.symbol, reason: 'creator_hold' });
  //   return false;
  // }
  if (token.is_wash_trading) {
    logger.warn('token_skipped', { mint: token.address, symbol: token.symbol, reason: 'wash_trading' });
    return false;
  }

  const completeTime = token.complete_cost_time / 60;
  if (completeTime < 8) {
    logger.warn('token_skipped', { mint: token.address, symbol: token.symbol, reason: 'recently_completed', completeTime });
    return false;
  }
  if (completeTime > 75) {
    logger.warn('token_skipped', { mint: token.address, symbol: token.symbol, reason: 'too_old', completeTime });
    return false;
  }

  return true;
}
