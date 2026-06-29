import {
  getGmgnClient,
  type FollowWalletTrade,
} from "../services/gmgn-client.ts";
import { shouldSkipToken } from "../db/queries.ts";
import { logger } from "../utils/logger.ts";
import { minutesSince } from "../utils/math.ts";

export type { FollowWalletTrade };

// Trade lebih tua dari ini sudah di luar entry window valid (lihat juga
// ENTRY_WINDOW_VALID_MIN di smart-money.ts) — tidak ada gunanya diteruskan
// ke enrichment karena scoring-nya pasti rendah, cuma buang API call.
const MAX_TRADE_AGE_MIN = 45;

// ── Candidate ──────────────────────────────────────────────────────────────────
// Satu candidate = satu token (base_address) yang terdeteksi dibeli oleh satu
// atau lebih followed wallet. Trade mentahnya tetap disimpan untuk diteruskan
// ke scoreSmartMoney() di scorer.ts — tidak perlu fetch ulang.

export interface ScanCandidate {
  mintAddress: string;
  symbol: string;
  trades: FollowWalletTrade[]; // semua trade buy untuk token ini, dari followed wallets
}

export async function scanFollowedWalletActivity(): Promise<ScanCandidate[]> {
  const client = getGmgnClient();

  let trades: FollowWalletTrade[];
  try {
    trades = await client.getFollowWallet({ side: "buy", limit: 100 });
  } catch (err) {
    logger.error("scan_failed", { error: String(err) });
    return [];
  }

  // ── Group by base_address (token) ───────────────────────────────────────────
  const grouped = new Map<string, FollowWalletTrade[]>();
  let skippedStaleTrades = 0;

  for (const t of trades) {
    const ageMin = minutesSince(t.timestamp);
    if (ageMin > MAX_TRADE_AGE_MIN) {
      skippedStaleTrades++;
      continue; // skip trade yang sudah terlalu lama
    }

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
      symbol: tokenTrades[0]?.base_token?.symbol ?? "???",
      trades: tokenTrades,
    });
  }

  logger.info("scan_complete", {
    total_trades: trades.length,
    skipped_stale_trades: skippedStaleTrades,
    distinct_tokens: grouped.size,
    passed: passed.length,
    skipped_dedup: skippedDedup,
  });

  return passed;
}
