/** Shared types for the automated trading engine. */

export type Chain = "sol" | "bsc" | "base" | "eth";
export type Mode = "paper" | "live";
export type RunState = "stopped" | "running" | "halted";

/** Everything the dashboard can change. Persisted to data/config.json. */
export type TradeConfig = {
  chain: Chain;
  mode: Mode;
  /** Minutes between full scan + analysis cycles. */
  intervalMinutes: number;
  /** Seconds between price refreshes / exit checks (much faster than a scan). */
  monitorSeconds: number;
  /** Free-form user instructions injected into the analyst prompt. */
  prompt: string;

  // ── Risk envelope (enforced in code, never by the model) ────────────
  /** % of equity committed per new position. */
  riskPerTradePct: number;
  maxOpenPositions: number;
  /** Stop trading for the day once realised+unrealised loss exceeds this %. */
  maxDailyLossPct: number;
  /** Hard stop-loss per position, %. */
  stopLossPct: number;
  /** Ladder: sell `sell`% of the original size once PnL reaches `at`%. */
  takeProfit: { at: number; sell: number }[];
  /** Arm a trailing stop once PnL exceeds this %. */
  trailArmPct: number;
  /** Trailing stop distance from peak, %. */
  trailGivebackPct: number;
  /** Close a position that has gone nowhere after this many minutes. */
  timeStopMinutes: number;
  /** A position must clear this PnL% to survive the time stop. */
  timeStopMinPnlPct: number;
  /** Don't re-enter a token for this long after exiting it. */
  cooldownMinutes: number;

  // ── Entry gates ─────────────────────────────────────────────────────
  minLiquidityUsd: number;
  minVolume1hUsd: number;
  maxRugRatio: number;
  maxTop10HolderRate: number;
  minSmartDegenCount: number;
  /** Reject tokens younger than this (minutes). */
  minTokenAgeMinutes: number;
  /** Reject tokens older than this (minutes). 0 = no ceiling. */
  maxTokenAgeMinutes: number;
  slippagePct: number;

  // ── Wallet / accounting ─────────────────────────────────────────────
  /** Smallest position worth opening, USD. 0 = per-chain default. */
  minPositionUsd: number;
  /** Native units held back for gas and never sized into. 0 = per-chain default. */
  gasReserveNative: number;

  /** Starting balance for the paper ledger, USD. */
  paperStartEquityUsd: number;
  /** Wallet address for live mode. Must be bound to the GMGN API key. */
  walletAddress: string;
};

export type Candidate = {
  address: string;
  symbol: string;
  name: string;
  priceUsd: number;
  marketCapUsd: number;
  liquidityUsd: number;
  volume1hUsd: number;
  change5mPct: number;
  change1hPct: number;
  swaps1h: number;
  holderCount: number;
  smartDegenCount: number;
  renownedCount: number;
  rugRatio: number;
  top10HolderRate: number;
  devHolding: boolean;
  isWashTrading: boolean;
  isHoneypot: boolean;
  buyTax: number;
  sellTax: number;
  ageMinutes: number;
  launchpad: string;
  source: string;
  /** Populated by the gate pass. */
  gateFailures: string[];
  score: number;
};

export type Position = {
  id: string;
  chain: Chain;
  address: string;
  symbol: string;
  openedAt: number;
  /** USD committed at entry (after fees/slippage). */
  costUsd: number;
  /** Token units held right now. */
  qty: number;
  /** Token units bought originally — the ladder sells fractions of this. */
  originalQty: number;
  entryPrice: number;
  lastPrice: number;
  peakPrice: number;
  /** USD already taken off the table via partial exits. */
  realisedUsd: number;
  /** Take-profit rungs already filled, by index. */
  filledRungs: number[];
  trailArmed: boolean;
  thesis: string;
  /** Model conviction 0–100 at entry. */
  conviction: number;
  stopLossPct: number;
  /** Pool depth at entry — a later drain is an exit signal. */
  entryLiquidityUsd: number;
  orderId?: string;
  strategyOrderId?: string;
};

export type Trade = {
  id: string;
  chain: Chain;
  address: string;
  symbol: string;
  side: "buy" | "sell";
  mode: Mode;
  at: number;
  price: number;
  qty: number;
  usd: number;
  /** Realised PnL in USD — sells only. */
  pnlUsd?: number;
  pnlPct?: number;
  reason: string;
  txHash?: string;
  orderId?: string;
};

export type LogLevel = "info" | "trade" | "warn" | "error" | "model";

export type LogEntry = {
  id: number;
  at: number;
  level: LogLevel;
  msg: string;
  detail?: string;
};

export type EquityPoint = { at: number; equity: number };

export type Snapshot = {
  runState: RunState;
  haltReason: string;
  config: TradeConfig;
  positions: Position[];
  trades: Trade[];
  logs: LogEntry[];
  equity: EquityPoint[];
  stats: Stats;
  cycle: {
    count: number;
    lastRunAt: number;
    nextRunAt: number;
    busy: boolean;
    phase: string;
    lastCandidates: Candidate[];
  };
  liveReady: boolean;
};

export type Stats = {
  equity: number;
  cash: number;
  exposure: number;
  realisedUsd: number;
  unrealisedUsd: number;
  peakEquity: number;
  troughEquity: number;
  maxDrawdownPct: number;
  wins: number;
  losses: number;
  winRatePct: number;
  dayStartEquity: number;
  dayPnlPct: number;
};

/** What the analyst model must return each cycle. */
export type Decision = {
  entries: {
    address: string;
    symbol?: string;
    conviction: number;
    sizeMultiplier?: number;
    stopLossPct?: number;
    thesis: string;
  }[];
  exits: { address: string; percent: number; reason: string }[];
  notes: string;
};
