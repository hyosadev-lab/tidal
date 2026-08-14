/** Shared types for the automated trading engine. */

export type Chain = "sol" | "bsc" | "base" | "eth";
export type Mode = "paper" | "live";
export type RunState = "stopped" | "running" | "halted";

/**
 * One row of the dashboard's exit builder.
 *   tp  — sell `sell`% once PnL reaches `at`%
 *   sl  — sell `sell`% once PnL falls to `at`% (negative)
 *   ttp — arm at `at`% PnL, then sell `sell`% on a `dd`% giveback from peak
 *   tsl — sell `sell`% on a `dd`% giveback from peak, armed from entry
 */
export type StrategyRule = { kind: "tp" | "sl" | "ttp" | "tsl"; at?: number; dd?: number; sell: number };

/** Everything the dashboard can change. Persisted to the `kv` table in data/tta.db. */
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
  /** On = every position opens on `strategy`. Off = the analyst writes one per entry. */
  fixedStrategy: boolean;
  /** The operator's exit rules, snapshotted onto a position at entry. Empty = the legacy fields. */
  strategy: StrategyRule[];
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

  // ── Discovery / execution ───────────────────────────────────────────
  /**
   * Dashboard "Refine" rows, keyed `<field>Min` / `<field>Max` — see `REFINE_FIELDS`
   * (config.ts) for the fields and their per-feed GMGN params. Feed query filters, not gates:
   * they are the only thing narrowing what the sweep fetches, and blank means unfiltered.
   * Nothing here disqualifies a candidate — `runGates` is the only thing that does.
   */
  refine: Record<string, number>;
  /** Swap tolerance, %. 0 = auto: GMGN picks per route, paper uses `AUTO_SLIPPAGE_CAP`. */
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
  /**
   * Reported by one feed but not the other, so `null` means "this feed does not carry it",
   * never zero — see `numOrNull`. Availability, measured against the live API:
   *   rank feed (`trending`): change1mPct, buys, sells, devHoldRate, bundlerRate, feeUsd
   *   launchpad feed (`trenches`): buys, sells, netBuyUsd, devHoldRate, insiderRate,
   *     bundlerRate, feeUsd — but no price changes at all
   * Buy/sell *volume* is on neither feed; only the counts and the trenches net figure are.
   */
  change1mPct: number | null;
  buys: number | null;
  sells: number | null;
  netBuyUsd: number | null;
  devHoldRate: number | null;
  insiderRate: number | null;
  bundlerRate: number | null;
  feeUsd: number | null;
  isWashTrading: boolean;
  isHoneypot: boolean;
  ageMinutes: number;
  launchpad: string;
  source: string;
  /** Populated by the gate pass. */
  gateFailures: string[];
  score: number;
  /**
   * Set by the scan for rows that passed the gates: `"sent"` if the analyst was shown this
   * row, otherwise why it wasn't. Written here because held / cooldown / blacklist live in
   * the store and never travel on a Candidate — the dashboard cannot work it out.
   */
  analystNote?: string;
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
  /**
   * The exit plan this position runs on, snapshotted at entry — the operator's rows in
   * fixed mode, the analyst's in dynamic mode. Empty falls back to the config's
   * stop / trail / ladder. Indexes into it are what `filledRungs` holds.
   */
  strategy?: StrategyRule[];
  /** Take-profit rungs already filled, by index. */
  filledRungs: number[];
  trailArmed: boolean;
  thesis: string;
  /** Model conviction 0–100 at entry. */
  conviction: number;
  stopLossPct: number;
  /**
   * % this position must gain from `entryPrice` before selling it returns what it cost — the
   * entry's fees are already paid and inside `costUsd`, the exit's are not. Measured at entry
   * off the real fill, so it carries the flat chain fee this position's size had to swallow:
   * the same trade is a 2% hurdle at $200 and a 12% one at $5. Absent on older positions,
   * which read as 0 and behave as they always did.
   */
  breakevenPct?: number;
  /** Pool depth at entry — a later drain is an exit signal. */
  entryLiquidityUsd: number;
  /**
   * Market cap at entry. Display only: the dashboard reads a position in market caps rather
   * than in per-token prices, and the current one is this scaled by `lastPrice / entryPrice`
   * — supply is fixed on a graduated token, so the two move together. Absent on positions
   * opened before this was recorded.
   */
  entryMarketCapUsd?: number;
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
    /** Dynamic mode only — the exit plan the model wants for this position. */
    strategy?: StrategyRule[];
    thesis: string;
  }[];
  exits: { address: string; percent: number; reason: string }[];
  notes: string;
};
