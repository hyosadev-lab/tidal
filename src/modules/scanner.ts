import { getGmgnClient, type FollowWalletTrade } from '../services/gmgn-client.ts';
import { shouldSkipToken } from '../db/queries.ts';
import { logger } from '../utils/logger.ts';

export type { FollowWalletTrade };

// ── Candidate ──────────────────────────────────────────────────────────────────
// Satu candidate = satu token (base_address) yang terdeteksi dibeli oleh satu
// atau lebih followed wallet. Trade mentahnya tetap disimpan untuk diteruskan
// ke scoreSmartMoney() di scorer.ts — tidak perlu fetch ulang.

export interface ScanCandidate {
  mintAddress: string;
  symbol: string;
  trades: FollowWalletTrade[];   // semua trade buy untuk token ini, dari followed wallets
}

export async function scanFollowedWalletActivity(): Promise<ScanCandidate[]> {
  const client = getGmgnClient();

  let trades: FollowWalletTrade[];
  try {
    trades = await client.getFollowWallet({ side: 'buy', limit: 100 });
  } catch (err) {
    logger.error('scan_failed', { error: String(err) });
    return [];
  }

  // ── Group by base_address (token) ───────────────────────────────────────────
  const grouped = new Map<string, FollowWalletTrade[]>();
  for (const t of trades) {
    const list = grouped.get(t.base_address);
    if (list) {
      list.push(t);
    } else {
      grouped.set(t.base_address, [t]);
    }
  }

  const passed: ScanCandidate[] = [];
  let skippedDedup = 0;

  for (const [mintAddress, tokenTrades] of grouped) {
    // Dedup: skip if already in positions or active trades
    if (shouldSkipToken(mintAddress)) {
      skippedDedup++;
      continue;
    }

    passed.push({
      mintAddress,
      symbol: tokenTrades[0]?.base_token?.symbol ?? '???',
      trades: tokenTrades,
    });
  }

  logger.info('scan_complete', {
    total_trades: trades.length,
    distinct_tokens: grouped.size,
    passed: passed.length,
    skipped_dedup: skippedDedup,
  });

  return passed;
}
