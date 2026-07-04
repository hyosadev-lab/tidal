import { type FollowWalletTrade } from '../services/gmgn-client.ts';
import { minutesSince } from '../utils/math.ts';

// ── Entry window tiers (minutes since trade timestamp) ────────────────────
const ENTRY_WINDOW_HOT_MIN   = 5;  // < 5m  → hot signal
const ENTRY_WINDOW_FRESH_MIN = 20; // < 20m → fresh signal
const ENTRY_WINDOW_VALID_MIN = 40; // < 40m → still valid, weaker

const CLUSTER_HIGH_CONVICTION = 3; // 3+ distinct followed wallets → high conviction
const CLUSTER_GOOD_SIGNAL     = 2; // 2  distinct followed wallets → good signal

export type EntryWindow = 'hot' | 'fresh' | 'valid' | 'stale' | 'none';

export interface SmartMoneySignal {
  score: number;                    // 0-100

  // Core presence — HANYA wallet yang tervalidasi masih hold (lihat catatan)
  hasFollowedEntry: boolean;
  recentEntry: boolean;
  recentEntryCount: number;

  // Timing — HANYA dihitung dari wallet yang masih hold
  hotEntryCount: number;            // distinct wallets holding, trade < 5m ago
  freshEntryCount: number;          // distinct wallets holding, trade 5–20m ago
  validEntryCount: number;          // distinct wallets holding, trade 20–40m ago
  bestEntryWindow: EntryWindow;

  // Conviction — HANYA dari wallet yang masih hold
  fullOpenCount: number;
  partialAddCount: number;

  // Exit tracking (BARU) — wallet yang sudah tidak hold, terdeteksi dari sell
  exitedWalletCount: number;        // latest action = full close (side=sell, is_open_or_close=1)
  reducedWalletCount: number;       // latest action = partial reduce (side=sell, is_open_or_close=0)
  hasRecentSmartMoneyExit: boolean;

  // Additional quality — HANYA dari wallet yang masih hold
  totalSolInvested: number;
  distinctWalletCount: number;      // distinct wallet MASIH HOLD (bukan total historis)
}

function zeroSignal(overrides: Partial<SmartMoneySignal> = {}): SmartMoneySignal {
  return {
    score: 0,
    hasFollowedEntry: false,
    recentEntry: false,
    recentEntryCount: 0,
    hotEntryCount: 0,
    freshEntryCount: 0,
    validEntryCount: 0,
    bestEntryWindow: 'none',
    fullOpenCount: 0,
    partialAddCount: 0,
    exitedWalletCount: 0,
    reducedWalletCount: 0,
    hasRecentSmartMoneyExit: false,
    totalSolInvested: 0,
    distinctWalletCount: 0,
    ...overrides,
  };
}

/**
 * @param trades - SEMUA trade (buy DAN sell) dari followed wallets untuk satu
 *                 token tertentu (base_address sudah difilter ke satu mint,
 *                 hasil grouping di scanner.ts, sudah difilter freshness).
 *
 * Logika inti — validasi hold status per wallet SEBELUM dihitung ke sinyal apapun:
 *   1. Group by wallet (maker), ambil trade PALING BARU (buy atau sell, mana
 *      saja yang timestamp-nya lebih baru) — bukan buy terbaru saja seperti
 *      versi sebelumnya.
 *   2. Kalau aksi terakhir wallet itu 'buy' → dianggap masih hold, dihitung
 *      seperti biasa (entry window tier, full open/partial add, SOL invested).
 *   3. Kalau aksi terakhir 'sell' dengan is_open_or_close=1 → wallet itu
 *      SUDAH EXIT PENUH. Tidak dihitung ke recentEntryCount/hotEntryCount/dst
 *      sama sekali — malah dicatat sebagai exitedWalletCount, yang jadi
 *      penalti ke score.
 *   4. Kalau aksi terakhir 'sell' dengan is_open_or_close=0 → partial reduce,
 *      masih hold sisa posisi tapi aksi terakhirnya mengurangi bukan menambah.
 *      Tidak dihitung sebagai sinyal bullish (recentEntryCount dst), tapi juga
 *      bukan full exit — dicatat terpisah di reducedWalletCount, tidak masuk
 *      penalti sebesar full exit.
 *
 * Ini mencegah kasus: wallet buy di T-5m, lalu sell penuh di T-2m — versi lama
 * akan salah membaca ini sebagai "hot fresh entry", padahal wallet itu sudah
 * tidak punya posisi sama sekali di token ini.
 */
export function scoreSmartMoney(trades: FollowWalletTrade[]): SmartMoneySignal {
  if (trades.length === 0) return zeroSignal();

  // ── Group by wallet, ambil trade PALING BARU (buy atau sell) ────────────
  const latestByWallet = new Map<string, FollowWalletTrade>();
  for (const t of trades) {
    const existing = latestByWallet.get(t.maker);
    if (!existing || t.timestamp > existing.timestamp) {
      latestByWallet.set(t.maker, t);
    }
  }

  // ── Klasifikasi wallet berdasarkan aksi terakhir ─────────────────────────
  let hotEntryCount = 0;
  let freshEntryCount = 0;
  let validEntryCount = 0;
  let fullOpenCount = 0;
  let partialAddCount = 0;
  let totalSolInvested = 0;
  let holdingWalletCount = 0;

  let exitedWalletCount = 0;
  let reducedWalletCount = 0;

  for (const t of latestByWallet.values()) {
    if (t.side === 'sell') {
      if (t.is_open_or_close === 1) {
        exitedWalletCount++; // full close — sudah tidak hold sama sekali
      } else {
        reducedWalletCount++; // partial reduce — masih hold sisa, tapi aksi terakhir mengurangi
      }
      continue; // wallet ini TIDAK dihitung ke sinyal entry apapun di bawah
    }

    // t.side === 'buy' → aksi terakhir adalah beli, dianggap masih hold
    holdingWalletCount++;
    const ageMin = minutesSince(t.timestamp);

    if (ageMin < ENTRY_WINDOW_HOT_MIN) {
      hotEntryCount++;
    } else if (ageMin < ENTRY_WINDOW_FRESH_MIN) {
      freshEntryCount++;
    } else if (ageMin < ENTRY_WINDOW_VALID_MIN) {
      validEntryCount++;
    }

    if (t.is_open_or_close === 1) {
      fullOpenCount++;
    } else {
      partialAddCount++;
    }

    const solAmount = parseFloat(t.quote_amount);
    if (!isNaN(solAmount)) totalSolInvested += solAmount;
  }

  const distinctWalletCount = holdingWalletCount;
  const hasFollowedEntry = distinctWalletCount > 0;
  const recentEntryCount = hotEntryCount + freshEntryCount + validEntryCount;
  const recentEntry = recentEntryCount > 0;
  const hasRecentSmartMoneyExit = exitedWalletCount > 0;

  const bestEntryWindow: EntryWindow =
    hotEntryCount > 0
      ? 'hot'
      : freshEntryCount > 0
        ? 'fresh'
        : validEntryCount > 0
          ? 'valid'
          : distinctWalletCount > 0
            ? 'stale'
            : 'none';

  // ── Scoring ──────────────────────────────────────────────────────────
  //
  // Cluster strength (recent distinct wallet entries) → 40 pts
  // Entry window tightness                            → 20 pts
  // Conviction — full position open ratio              → 25 pts
  // Capital commitment — totalSolInvested               → 15 pts
  // Exit penalty — dikurangi dari total, bukan komponen positif

  let score = 0;

  // 1. Cluster strength (40 pts)
  if (recentEntryCount >= CLUSTER_HIGH_CONVICTION) {
    score += 40;
  } else if (recentEntryCount >= CLUSTER_GOOD_SIGNAL) {
    score += 27;
  } else if (recentEntryCount === 1) {
    score += 13;
  }

  // 2. Entry window tightness (20 pts)
  if (hotEntryCount > 0) {
    score += 20;
  } else if (freshEntryCount > 0) {
    score += 13;
  } else if (validEntryCount > 0) {
    score += 6;
  }

  // 3. Conviction — full open ratio (25 pts)
  if (fullOpenCount >= CLUSTER_HIGH_CONVICTION) {
    score += 25;
  } else if (fullOpenCount >= CLUSTER_GOOD_SIGNAL) {
    score += 18;
  } else if (fullOpenCount === 1) {
    score += 11;
  } else if (partialAddCount > 0) {
    score += 4;
  }

  // 4. Capital commitment — totalSolInvested (15 pts)
  if (totalSolInvested >= 10)      score += 15;
  else if (totalSolInvested >= 5)  score += 10;
  else if (totalSolInvested >= 2)  score += 5;

  // 5. Exit penalty — followed wallet yang exit penuh di token yang sama
  // adalah sinyal negatif kuat, terlepas dari berapa banyak yang masih hold.
  // [Menebak] besaran penalti arbitrer — sesuaikan setelah lihat data riil
  // seberapa sering pola "buy lalu exit cepat" muncul di followed wallets.
  if (exitedWalletCount >= CLUSTER_HIGH_CONVICTION) {
    score -= 40; // 3+ wallet full-exit — sinyal distribusi kuat, hampir batalkan skor manapun
  } else if (exitedWalletCount >= CLUSTER_GOOD_SIGNAL) {
    score -= 25;
  } else if (exitedWalletCount === 1) {
    score -= 12;
  }
  // reducedWalletCount tidak dipenalti sekeras exitedWalletCount — partial
  // reduce bisa berarti profit-taking normal, bukan kehilangan keyakinan total
  if (reducedWalletCount >= CLUSTER_GOOD_SIGNAL) {
    score -= 6;
  }

  return {
    score: Math.max(0, Math.min(score, 100)),
    hasFollowedEntry,
    recentEntry,
    recentEntryCount,
    hotEntryCount,
    freshEntryCount,
    validEntryCount,
    bestEntryWindow,
    fullOpenCount,
    partialAddCount,
    exitedWalletCount,
    reducedWalletCount,
    hasRecentSmartMoneyExit,
    totalSolInvested,
    distinctWalletCount,
  };
}
