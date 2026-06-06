import { type HolderWallet } from '../services/gmgn-client.ts';
import { lamportsToSol, minutesSince } from '../utils/math.ts';

const RECENT_ENTRY_MINUTES = 5;           // < 5 minutes
const MIN_SOL_BALANCE = 30;               // SOL balance threshold for "trusted" wallet
const MIN_AMOUNT_PCT_HIGH = 0.005;        // 0.5% of supply
const MIN_AMOUNT_PCT_LOW = 0.001;         // 0.1% of supply

export interface SmartMoneySignal {
  score: number;
  smartWalletCount: number;              // total smart wallets in holder list
  activeSmartWalletCount: number;        // wallets still holding (sell_amount_percentage < 0.5)
  highBalanceActiveCount: number;        // active wallets with SOL balance > 10
  avgAmountPct: number;                  // average amount_percentage of active wallets
  recentEntry: boolean;                  // any active wallet entered < 5 minutes ago
  smartWalletsStillHolding: number;      // alias for activeSmartWalletCount (kept for DB compat)
}

export function scoreSmartMoney(holders: HolderWallet[]): SmartMoneySignal {
  if (holders.length === 0) {
    return {
      score: 0,
      smartWalletCount: 0,
      activeSmartWalletCount: 0,
      highBalanceActiveCount: 0,
      avgAmountPct: 0,
      recentEntry: false,
      smartWalletsStillHolding: 0,
    };
  }

  const smartWalletCount = holders.length;

  // Active = masih holding (sell_amount_percentage < 0.5)
  const activeWallets = holders.filter(
    (h) => (h.sell_amount_percentage ?? 1) < 0.5
  );
  const activeSmartWalletCount = activeWallets.length;

  // ── Gate: all smart money has exited ─────────────────────────────────────
  if (smartWalletCount > 0 && activeSmartWalletCount === 0) {
    return {
      score: 0,
      smartWalletCount,
      activeSmartWalletCount: 0,
      highBalanceActiveCount: 0,
      avgAmountPct: 0,
      recentEntry: false,
      smartWalletsStillHolding: 0,
    };
  }

  // Active wallets dengan SOL balance > 10
  const highBalanceActiveCount = activeWallets.filter(
    (h) => lamportsToSol(h.native_balance) > MIN_SOL_BALANCE
  ).length;

  // Average amount_percentage of active wallets
  const avgAmountPct = activeWallets.length > 0
    ? activeWallets.reduce((sum, h) => sum + (h.amount_percentage ?? 0), 0) / activeWallets.length
    : 0;

  // Recent entry: any active wallet entered < 5 minutes ago
  const recentEntry = activeWallets.some(
    (h) => h.start_holding_at && minutesSince(h.start_holding_at) < RECENT_ENTRY_MINUTES
  );

  // ── Scoring ──────────────────────────────────────────────────────────────
  let score = 0;

  // 1. Active smart wallet count (+40 pts max)
  if (activeSmartWalletCount > 5) {
    score += 40;
  } else if (activeSmartWalletCount >= 3) {
    score += 25;
  } else if (activeSmartWalletCount >= 1) {
    score += 15;
  }

  // 2. Active wallets dengan SOL balance > 10 (+30 pts max)
  if (highBalanceActiveCount > 3) {
    score += 30;
  } else if (highBalanceActiveCount >= 1) {
    score += 20;
  }

  // 3. Recent entry < 5 menit (+15 pts)
  if (recentEntry) score += 15;

  // 4. Average amount_percentage — seberapa serius mereka di token ini (+15 pts max)
  if (avgAmountPct >= MIN_AMOUNT_PCT_HIGH) {
    score += 15;   // > 0.5% supply
  } else if (avgAmountPct >= MIN_AMOUNT_PCT_LOW) {
    score += 8;    // > 0.1% supply
  }

  return {
    score: Math.min(score, 100),
    smartWalletCount,
    activeSmartWalletCount,
    highBalanceActiveCount,
    avgAmountPct,
    recentEntry,
    smartWalletsStillHolding: activeSmartWalletCount,
  };
}
