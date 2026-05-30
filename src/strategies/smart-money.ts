import { type HolderWallet } from '../services/gmgn-client.ts';
import { minutesSince } from '../utils/math.ts';

export interface SmartMoneySignal {
  score: number;
  smartWalletCount: number;
  totalSmartHoldingPct: number;
  recentEntry: boolean;
  smartWalletsStillHolding: number;
}

const RECENT_ENTRY_MINUTES = 30;

export function scoreSmartMoney(holders: HolderWallet[]): SmartMoneySignal {
  if (holders.length === 0) {
    return {
      score: 0,
      smartWalletCount: 0,
      totalSmartHoldingPct: 0,
      recentEntry: false,
      smartWalletsStillHolding: 0,
    };
  }

  const smartWalletCount = holders.length;

  const totalSmartHoldingPct = holders.reduce(
    (sum, h) => sum + (h.amount_percentage ?? 0),
    0
  );

  const recentEntry = holders.some(
    (h) => h.start_holding_at && minutesSince(h.start_holding_at) <= RECENT_ENTRY_MINUTES
  );

  const smartWalletsStillHolding = holders.filter(
    (h) => (h.sell_amount_percentage ?? 1) < 0.5
  ).length;

  // ── Scoring ──────────────────────────────────────────────────────────────
  let score = 0;

  // Smart wallet count
  if (smartWalletCount > 5) {
    score += 50;
  } else if (smartWalletCount >= 3) {
    score += 30;
  } else if (smartWalletCount >= 1) {
    score += 10;
  }

  // Recent entry bonus
  if (recentEntry) score += 15;

  // Still holding bonus
  if (smartWalletsStillHolding >= 3) score += 35;

  return {
    score: Math.min(score, 100),
    smartWalletCount,
    totalSmartHoldingPct,
    recentEntry,
    smartWalletsStillHolding,
  };
}
