import { readFileSync } from 'fs';
import { join } from 'path';
import { type HolderWallet } from '../services/gmgn-client.ts';
import { minutesSince } from '../utils/math.ts';

// ── Entry window tiers (minutes since wallet first bought token) ──────────────
const ENTRY_WINDOW_HOT_MIN   = 5;   // < 5m  → hot signal
const ENTRY_WINDOW_FRESH_MIN = 25;  // < 25m → fresh signal
const ENTRY_WINDOW_VALID_MIN = 45;  // < 45m → still valid, weaker

// ── Cluster strength thresholds ───────────────────────────────────────────────
const CLUSTER_HIGH_CONVICTION = 3;  // 3+ tracked wallets → high conviction
const CLUSTER_GOOD_SIGNAL     = 2;  // 2  tracked wallets → good signal

// ── Tracked wallet loader ─────────────────────────────────────────────────────
// Loaded once at startup from wallets.json.
// Wallets in this list are pre-qualified — no stats checks needed.

let _trackedWallets: Set<string> | null = null;

export function getTrackedWallets(): Set<string> {
  if (_trackedWallets) return _trackedWallets;

  const filePath = join(process.cwd(), 'wallets.json');
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as { wallets?: string[] };
    const wallets = parsed.wallets ?? [];
    _trackedWallets = new Set(wallets.map((w) => w.trim()).filter(Boolean));
    console.info(`[smart-money] Loaded ${_trackedWallets.size} tracked wallets from wallets.json`);
  } catch (err) {
    console.warn(`[smart-money] Could not load wallets.json: ${err}. Smart money signal will be zero.`);
    _trackedWallets = new Set();
  }

  return _trackedWallets;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type EntryWindow = 'hot' | 'fresh' | 'valid' | 'stale' | 'none';

export interface SmartMoneySignal {
  score: number;

  // ── Core 3 questions ──────────────────────────────────────────────────────
  hasTrackedEntry: boolean;          // Q1: ada tracked wallet yang entry?
  recentEntry: boolean;              // Q2: ada yang entry dalam valid window?
  recentEntryCount: number;          // Q3: berapa banyak tracked wallet yang baru entry?

  // ── Entry window breakdown ─────────────────────────────────────────────────
  hotEntryCount: number;             // wallets entered < 5m ago
  freshEntryCount: number;           // wallets entered 5–25m ago
  validEntryCount: number;           // wallets entered 25–45m ago
  bestEntryWindow: EntryWindow;      // tightest window yang ada entry-nya

  // ── Holder state ───────────────────────────────────────────────────────────
  trackedWalletCount: number;        // total tracked wallets ditemukan di token ini
  activeTrackedCount: number;        // tracked wallets masih holding (sell_amount_percentage < 0.5)
}

// ── Zero signal ───────────────────────────────────────────────────────────────

function zeroSignal(overrides: Partial<SmartMoneySignal> = {}): SmartMoneySignal {
  return {
    score: 0,
    hasTrackedEntry: false,
    recentEntry: false,
    recentEntryCount: 0,
    hotEntryCount: 0,
    freshEntryCount: 0,
    validEntryCount: 0,
    bestEntryWindow: 'none',
    trackedWalletCount: 0,
    activeTrackedCount: 0,
    ...overrides,
  };
}

// ── Main scoring function ──────────────────────────────────────────────────────
//
// @param traders - smart_degen wallets dari token_top_traders
//
// Logic:
//   1. Filter traders yang ada di tracked wallet list
//   2. Filter yang masih holding (sell_amount_percentage < 0.5)
//   3. Cek recency of entry via start_holding_at
//   4. Score berdasarkan cluster strength + entry window

export function scoreSmartMoney(holders: HolderWallet[]): SmartMoneySignal {
  const trackedWallets = getTrackedWallets();

  if (holders.length === 0 || trackedWallets.size === 0) return zeroSignal();

  // ── Filter: hanya tracked wallets ─────────────────────────────────────────
  const trackedHolders = holders.filter((h) => trackedWallets.has(h.address));
  const trackedWalletCount = trackedHolders.length;

  if (trackedWalletCount === 0) return zeroSignal();

  const hasTrackedEntry = true;

  // ── Filter: hanya yang masih holding ──────────────────────────────────────
  const activeTracked = trackedHolders.filter(
    (h) => (h.sell_amount_percentage ?? 1) < 0.5
  );
  const activeTrackedCount = activeTracked.length;

  // Gate: semua sudah exit → tidak ada sinyal bullish
  if (activeTrackedCount === 0) {
    return zeroSignal({
      hasTrackedEntry,
      trackedWalletCount,
      activeTrackedCount: 0,
    });
  }

  // ── Entry window analysis ─────────────────────────────────────────────────
  let hotEntryCount   = 0;
  let freshEntryCount = 0;
  let validEntryCount = 0;

  for (const h of activeTracked) {
    if (!h.start_holding_at) continue;
    const ageMin = minutesSince(h.start_holding_at);

    if (ageMin < ENTRY_WINDOW_HOT_MIN) {
      hotEntryCount++;
    } else if (ageMin < ENTRY_WINDOW_FRESH_MIN) {
      freshEntryCount++;
    } else if (ageMin < ENTRY_WINDOW_VALID_MIN) {
      validEntryCount++;
    }
  }

  const recentEntryCount = hotEntryCount + freshEntryCount + validEntryCount;
  const recentEntry      = recentEntryCount > 0;

  const bestEntryWindow: EntryWindow =
    hotEntryCount   > 0 ? 'hot'   :
    freshEntryCount > 0 ? 'fresh' :
    validEntryCount > 0 ? 'valid' :
    activeTrackedCount  > 0 ? 'stale' : 'none';

  // ── Scoring ───────────────────────────────────────────────────────────────
  //
  // Cluster strength (recent tracked entries)  → 55 pts  (primary signal)
  // Entry window tightness                     → 30 pts  (recency bonus)
  // Active tracked wallets holding             → 15 pts  (baseline conviction)
  //
  // Max total: 100 pts (capped)

  let score = 0;

  // 1. Cluster strength — recent tracked entries (55 pts)
  if (recentEntryCount >= CLUSTER_HIGH_CONVICTION) {
    score += 55;  // 3+ wallets → high conviction
  } else if (recentEntryCount >= CLUSTER_GOOD_SIGNAL) {
    score += 38;  // 2 wallets → good signal
  } else if (recentEntryCount === 1) {
    score += 20;  // 1 wallet → weak signal
  }
  // 0 recent entries → 0 pts dari cluster

  // 2. Entry window tightness (30 pts)
  if (hotEntryCount > 0) {
    score += 30;  // < 5m → sinyal terkuat
  } else if (freshEntryCount > 0) {
    score += 20;  // 5–25m → fresh
  } else if (validEntryCount > 0) {
    score += 10;  // 25–45m → masih valid, melemah
  }

  // 3. Active tracked wallets holding (15 pts)
  if (activeTrackedCount >= 3) {
    score += 15;
  } else if (activeTrackedCount === 2) {
    score += 10;
  } else if (activeTrackedCount === 1) {
    score += 5;
  }

  return {
    score: Math.min(score, 100),
    hasTrackedEntry,
    recentEntry,
    recentEntryCount,
    hotEntryCount,
    freshEntryCount,
    validEntryCount,
    bestEntryWindow,
    trackedWalletCount,
    activeTrackedCount,
  };
}
