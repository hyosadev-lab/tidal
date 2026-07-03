import { type FollowWalletTrade } from '../services/gmgn-client.ts';
import { minutesSince } from '../utils/math.ts';

// ── Entry window tiers (minutes since trade timestamp) ────────────────────
// Catatan: interface baru mendefinisikan fresh sebagai 5-20m dan valid 20-40m
// (bukan 5-25m/25-45m seperti versi lama di strategies/) — window dipersempit.
const ENTRY_WINDOW_HOT_MIN   = 5;  // < 5m  → hot signal
const ENTRY_WINDOW_FRESH_MIN = 20; // < 20m → fresh signal
const ENTRY_WINDOW_VALID_MIN = 40; // < 40m → still valid, weaker

const CLUSTER_HIGH_CONVICTION = 3; // 3+ distinct followed wallets → high conviction
const CLUSTER_GOOD_SIGNAL     = 2; // 2  distinct followed wallets → good signal

export type EntryWindow = 'hot' | 'fresh' | 'valid' | 'stale' | 'none';

export interface SmartMoneySignal {
  score: number;                    // 0-100

  // Core presence
  hasFollowedEntry: boolean;
  recentEntry: boolean;
  recentEntryCount: number;

  // Timing
  hotEntryCount: number;            // distinct wallets, trade < 5m ago
  freshEntryCount: number;          // distinct wallets, trade 5–20m ago
  validEntryCount: number;          // distinct wallets, trade 20–40m ago
  bestEntryWindow: EntryWindow;     // tightest window yang ada entry-nya

  // Conviction
  fullOpenCount: number;
  partialAddCount: number;

  // Additional quality
  totalSolInvested: number;
  distinctWalletCount: number;      // total distinct followed wallets yang trade token ini
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
    totalSolInvested: 0,
    distinctWalletCount: 0,
    ...overrides,
  };
}

/**
 * @param trades - trade buy dari followed wallets untuk satu token tertentu
 *                 (base_address sudah difilter ke satu mint sebelum dipanggil,
 *                 hasil grouping di scanner.ts). Diasumsikan side sudah 'buy'
 *                 semua — caller (scanner.ts) yang filter side.
 *
 * CATATAN totalSolInvested: [Menebak] dihitung dari FollowWalletTrade.quote_amount,
 * dengan asumsi quote token pada trade meme-coin di Solana hampir selalu SOL.
 * Ini TIDAK diverifikasi terhadap quote_address secara eksplisit — kalau ada
 * followed wallet yang trade lewat pool dengan quote non-SOL (jarang tapi
 * mungkin), angka ini akan salah. Kalau perlu presisi, cross-check
 * quote_address terhadap SOL mint address sebelum sum.
 */
export function scoreSmartMoney(trades: FollowWalletTrade[]): SmartMoneySignal {
  if (trades.length === 0) return zeroSignal();

  // ── Group by distinct followed wallet, ambil trade buy terbaru per wallet ──
  const latestByWallet = new Map<string, FollowWalletTrade>();
  for (const t of trades) {
    const existing = latestByWallet.get(t.maker);
    if (!existing || t.timestamp > existing.timestamp) {
      latestByWallet.set(t.maker, t);
    }
  }

  const distinctWalletCount = latestByWallet.size;
  const hasFollowedEntry = distinctWalletCount > 0;

  // ── Entry window + conviction analysis ─────────────────────────────────
  let hotEntryCount = 0;
  let freshEntryCount = 0;
  let validEntryCount = 0;
  let fullOpenCount = 0;
  let partialAddCount = 0;
  let totalSolInvested = 0;

  for (const t of latestByWallet.values()) {
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

  const recentEntryCount = hotEntryCount + freshEntryCount + validEntryCount;
  const recentEntry = recentEntryCount > 0;

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
  // Capital commitment — totalSolInvested               → 15 pts (baru)

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

  // 4. Capital commitment — totalSolInvested (15 pts, baru)
  // [Menebak] threshold arbitrer — sesuaikan setelah lihat distribusi riil
  // totalSolInvested dari followed wallets di data log.
  if (totalSolInvested >= 10)      score += 15;
  else if (totalSolInvested >= 5)  score += 10;
  else if (totalSolInvested >= 2)  score += 5;

  return {
    score: Math.min(score, 100),
    hasFollowedEntry,
    recentEntry,
    recentEntryCount,
    hotEntryCount,
    freshEntryCount,
    validEntryCount,
    bestEntryWindow,
    fullOpenCount,
    partialAddCount,
    totalSolInvested,
    distinctWalletCount,
  };
}
