import { type FollowWalletTrade } from "../services/gmgn-client.ts";
import { minutesSince } from "../utils/math.ts";

// ── Entry window tiers (minutes since trade timestamp) ────────────────────────
const ENTRY_WINDOW_HOT_MIN = 5; // < 5m  → hot signal
const ENTRY_WINDOW_FRESH_MIN = 25; // < 25m → fresh signal
const ENTRY_WINDOW_VALID_MIN = 45; // < 45m → still valid, weaker

// ── Cluster strength thresholds ───────────────────────────────────────────────
const CLUSTER_HIGH_CONVICTION = 3; // 3+ distinct followed wallets → high conviction
const CLUSTER_GOOD_SIGNAL = 2; // 2  distinct followed wallets → good signal

// ── Types ─────────────────────────────────────────────────────────────────────

export type EntryWindow = "hot" | "fresh" | "valid" | "stale" | "none";

export interface SmartMoneySignal {
  score: number;

  // ── Core questions ──────────────────────────────────────────────────────────
  hasFollowedEntry: boolean; // Q1: ada followed wallet yang beli token ini?
  recentEntry: boolean; // Q2: ada yang beli dalam valid window?
  recentEntryCount: number; // Q3: berapa banyak distinct followed wallet yang baru beli?

  // ── Entry window breakdown ─────────────────────────────────────────────────
  hotEntryCount: number; // distinct wallets, trade < 5m ago
  freshEntryCount: number; // distinct wallets, trade 5–25m ago
  validEntryCount: number; // distinct wallets, trade 25–45m ago
  bestEntryWindow: EntryWindow; // tightest window yang ada entry-nya

  // ── Conviction breakdown ───────────────────────────────────────────────────
  fullOpenCount: number; // distinct wallets dengan is_open_or_close === 1 (full position)
  partialAddCount: number; // distinct wallets dengan is_open_or_close === 0 (partial add)

  // ── Trade detail ───────────────────────────────────────────────────────────
  distinctWalletCount: number; // total distinct followed wallets yang trade token ini (buy, semua window)
  trades: FollowWalletTrade[]; // trade mentah yang relevan (sudah difilter side=buy untuk token ini)
}

// ── Zero signal ───────────────────────────────────────────────────────────────

function zeroSignal(
  overrides: Partial<SmartMoneySignal> = {},
): SmartMoneySignal {
  return {
    score: 0,
    hasFollowedEntry: false,
    recentEntry: false,
    recentEntryCount: 0,
    hotEntryCount: 0,
    freshEntryCount: 0,
    validEntryCount: 0,
    bestEntryWindow: "none",
    fullOpenCount: 0,
    partialAddCount: 0,
    distinctWalletCount: 0,
    trades: [],
    ...overrides,
  };
}

// ── Main scoring function ──────────────────────────────────────────────────────
//
// @param trades - trade buy dari followed wallets untuk satu token tertentu
//                 (base_address sudah difilter ke satu mint sebelum dipanggil,
//                 biasanya hasil grouping di scanner.ts)
//
// Logic:
//   1. Group by maker (distinct followed wallet)
//   2. Untuk tiap wallet, ambil trade buy paling baru sebagai representasi entry
//   3. Cek recency of entry via timestamp
//   4. Cek conviction via is_open_or_close (1 = full open, lebih kuat)
//   5. Score berdasarkan cluster strength + entry window + conviction

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

  // ── Entry window + conviction analysis ─────────────────────────────────────
  let hotEntryCount = 0;
  let freshEntryCount = 0;
  let validEntryCount = 0;
  let fullOpenCount = 0;
  let partialAddCount = 0;

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
  }

  const recentEntryCount = hotEntryCount + freshEntryCount + validEntryCount;
  const recentEntry = recentEntryCount > 0;

  const bestEntryWindow: EntryWindow =
    hotEntryCount > 0
      ? "hot"
      : freshEntryCount > 0
        ? "fresh"
        : validEntryCount > 0
          ? "valid"
          : distinctWalletCount > 0
            ? "stale"
            : "none";

  // ── Scoring ───────────────────────────────────────────────────────────────
  //
  // Cluster strength (recent distinct wallet entries) → 45 pts (primary signal)
  // Entry window tightness                            → 25 pts (recency bonus)
  // Conviction — full position open ratio              → 30 pts (is_open_or_close)
  //
  // Max total: 100 pts (capped)

  let score = 0;

  // 1. Cluster strength — recent distinct wallet entries (45 pts)
  if (recentEntryCount >= CLUSTER_HIGH_CONVICTION) {
    score += 45; // 3+ wallets → high conviction
  } else if (recentEntryCount >= CLUSTER_GOOD_SIGNAL) {
    score += 30; // 2 wallets → good signal
  } else if (recentEntryCount === 1) {
    score += 15; // 1 wallet → weak signal
  }
  // 0 recent entries → 0 pts dari cluster

  // 2. Entry window tightness (25 pts)
  if (hotEntryCount > 0) {
    score += 25; // < 5m → sinyal terkuat
  } else if (freshEntryCount > 0) {
    score += 17; // 5–25m → fresh
  } else if (validEntryCount > 0) {
    score += 8; // 25–45m → masih valid, melemah
  }

  // 3. Conviction — full position open ratio (30 pts)
  // is_open_or_close === 1 = full open/close, sinyal jauh lebih kuat dari partial add
  if (fullOpenCount >= CLUSTER_HIGH_CONVICTION) {
    score += 30; // 3+ full opens → very strong conviction
  } else if (fullOpenCount >= CLUSTER_GOOD_SIGNAL) {
    score += 22; // 2 full opens
  } else if (fullOpenCount === 1) {
    score += 14; // 1 full open
  } else if (partialAddCount > 0) {
    score += 5; // hanya partial add — sinyal lemah tapi bukan nol
  }

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
    distinctWalletCount,
    trades,
  };
}
