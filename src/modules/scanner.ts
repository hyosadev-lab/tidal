import { getGmgnClient, type TrenchesToken } from '../services/gmgn-client.ts';
import { tokenExists, insertTokenCandidate } from '../db/queries.ts';
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
    // Dedup check
    if (tokenExists(token.address)) {
      skippedDedup++;
      continue;
    }

    // Always insert to DB to avoid re-evaluating
    insertTokenCandidate({
      mintAddress: token.address,
      symbol: token.symbol,
      name: token.name,
      launchpadPlatform: token.launchpad_platform,
      graduatedAt: token.open_timestamp,
      liquidityUsd: token.liquidity,
      holderCount: token.holder_count,
      top10HolderRate: token.top_10_holder_rate,
      smartDegenCount: token.smart_degen_count,
      renownedCount: token.renowned_count,
      rugRatio: token.rug_ratio,
      creatorTokenStatus: token.creator_token_status,
      isWashTrading: token.is_wash_trading,
      usdMarketCap: token.usd_market_cap,
    });

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
  if (token.owner_renounced === "no") {
    logger.warn('token_skipped', { mint: token.address, symbol: token.symbol, reason: 'owner_not_renounced' });
    return false;
  }
  if (token.creator_token_status === "creator_hold") {
    logger.warn('token_skipped', { mint: token.address, symbol: token.symbol, reason: 'creator_hold' });
    return false;
  }
  if (token.is_wash_trading) {
    logger.warn('token_skipped', { mint: token.address, symbol: token.symbol, reason: 'wash_trading' });
    return false;
  }
  return true;
}
