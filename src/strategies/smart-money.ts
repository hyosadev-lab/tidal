import { type HolderWallet } from '../services/gmgn-client.ts';
import { lamportsToSol, minutesSince } from '../utils/math.ts';

const RECENT_ENTRY_MINUTES = 1; // < 1 minute

export interface SmartMoneySignal {
  score: number;
  smartWalletCount: number;          // total smart wallets in holder list
  activeSmartWalletCount: number;    // wallets still holding (sell_amount_percentage < 0.5)
  totalSmartHoldingPct: number;      // combined supply % held by active wallets
  avgSolBalance: number;             // average SOL balance of active wallets
  recentEntry: boolean;              // any active wallet entered < 1 minute ago
  smartWalletsStillHolding: number;  // alias for activeSmartWalletCount (kept for DB compat)
}

export function scoreSmartMoney(holders: HolderWallet[]): SmartMoneySignal {
  if (holders.length === 0) {
    return {
      score: 0,
      smartWalletCount: 0,
      activeSmartWalletCount: 0,
      totalSmartHoldingPct: 0,
      avgSolBalance: 0,
      recentEntry: false,
      smartWalletsStillHolding: 0,
    };
  }

  const smartWalletCount = holders.length;

  // Only wallets still holding — these are the ones that matter
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
      totalSmartHoldingPct: 0,
      avgSolBalance: 0,
      recentEntry: false,
      smartWalletsStillHolding: 0,
    };
  }

  const totalSmartHoldingPct = activeWallets.reduce(
    (sum, h) => sum + (h.amount_percentage ?? 0),
    0
  );

  // SOL balance: native_balance is in lamports (string)
  const solBalances = activeWallets.map((h) => lamportsToSol(h.native_balance));
  const avgSolBalance = solBalances.length > 0
    ? solBalances.reduce((sum, b) => sum + b, 0) / solBalances.length
    : 0;

  // Recent entry: any active wallet entered < 1 minute ago
  const recentEntry = activeWallets.some(
    (h) => h.start_holding_at && minutesSince(h.start_holding_at) < RECENT_ENTRY_MINUTES
  );

  // ── Scoring ──────────────────────────────────────────────────────────────
  let score = 0;

  // 1. Active smart wallet count (+60 pts max)
  //    Only count wallets still holding — exited wallets are not relevant
  if (activeSmartWalletCount > 5) {
    score += 60;
  } else if (activeSmartWalletCount >= 3) {
    score += 40;
  } else if (activeSmartWalletCount >= 1) {
    score += 20;
  }

  // 2. Average SOL balance of active wallets (+25 pts max)
  //    Higher SOL balance = more conviction and capital at risk
  if (avgSolBalance > 10) {
    score += 25;
  } else if (avgSolBalance >= 5) {
    score += 15;
  } else if (avgSolBalance >= 1) {
    score += 5;
  }

  // 3. Recent entry bonus (+15 pts)
  //    Active wallet entered < 1 minute ago = very fresh signal
  if (recentEntry) score += 15;

  return {
    score: Math.min(score, 100),
    smartWalletCount,
    activeSmartWalletCount,
    totalSmartHoldingPct,
    avgSolBalance,
    recentEntry,
    smartWalletsStillHolding: activeSmartWalletCount,
  };
}
