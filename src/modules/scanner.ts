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
// Filter ini berlaku SAMA untuk trade buy maupun sell — exit signal yang
// terlalu lama juga tidak relevan lagi untuk keputusan saat ini.
const MAX_TRADE_AGE_MIN = 45;

// ── Candidate ──────────────────────────────────────────────────────────────────
// Satu candidate = satu token (base_address) yang terdeteksi dibeli oleh satu
// atau lebih followed wallet. `trades` sekarang berisi BUY *dan* SELL untuk
// token ini — sell dibutuhkan supaya scoreSmartMoney() bisa memvalidasi
// apakah wallet yang barusan buy masih benar-benar hold atau sudah exit.
// Trigger candidate tetap dari aktivitas BUY — token yang followed wallet-nya
// cuma jual (tanpa ada buy sama sekali dalam window) TIDAK jadi candidate baru.

export interface ScanCandidate {
  mintAddress: string;
  symbol: string;
  trades: FollowWalletTrade[]; // buy + sell, dari followed wallets, sudah difilter freshness
}

export async function scanFollowedWalletActivity(): Promise<ScanCandidate[]> {
  const client = getGmgnClient();

  let trades: FollowWalletTrade[];
  try {
    // Tidak pakai filter `side` — butuh buy DAN sell dalam satu fetch supaya
    // status hold wallet bisa divalidasi (lihat smart-money.ts). Trade-off:
    // limit=100 (max API) sekarang terbagi antara buy+sell, bukan buy saja —
    // volume candidate buy per fetch bisa sedikit lebih rendah dari sebelumnya.
    trades = await client.getFollowWallet({ limit: 100 });
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
  let skippedNoBuyTrigger = 0;

  for (const [mintAddress, tokenTrades] of grouped) {
    // Trigger candidate HARUS ada minimal satu trade 'buy' — token yang
    // followed wallet-nya cuma jual (tidak ada buy sama sekali di window
    // fresh ini) bukan sinyal entry baru, jangan dievaluasi sebagai BUY candidate.
    const hasBuyTrigger = tokenTrades.some((t) => t.side === "buy");
    if (!hasBuyTrigger) {
      skippedNoBuyTrigger++;
      continue;
    }

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
    skipped_no_buy_trigger: skippedNoBuyTrigger,
    passed: passed.length,
    skipped_dedup: skippedDedup,
  });

  return passed;
}
