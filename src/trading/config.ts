import type { Chain, Mode, StrategyRule, TradeConfig } from "./types.ts";

/**
 * Constants, defaults and the clamps every dashboard input passes through — and nothing else.
 * This file has no imports beyond types on purpose: it is the floor of the pure layer, so
 * `plan.ts` can reach the clamps without dragging the database in behind them. Persistence
 * of the config lives with the rest of the persisted state, in `store.ts`.
 */

export const CHAINS: Chain[] = ["sol", "bsc", "base", "eth"];

/** Native currency address + decimals per chain — copied from the gmgn-swap skill table. */
export const NATIVE: Record<Chain, { symbol: string; address: string; decimals: number }> = {
  sol: { symbol: "SOL", address: "So11111111111111111111111111111111111111112", decimals: 9 },
  bsc: { symbol: "BNB", address: "0x0000000000000000000000000000000000000000", decimals: 18 },
  base: { symbol: "ETH", address: "0x0000000000000000000000000000000000000000", decimals: 18 },
  eth: { symbol: "ETH", address: "0x0000000000000000000000000000000000000000", decimals: 18 },
};

/**
 * Smallest position worth opening per chain. Driven by round-trip friction:
 * SOL gas is fractions of a cent, ETH mainnet gas is not.
 */
export const MIN_POSITION_USD: Record<Chain, number> = { sol: 3, bsc: 5, base: 5, eth: 25 };

/**
 * Cap on the simulated price impact of a paper fill when slippage is on auto. Live swaps ask
 * GMGN to pick per route; paper has no route to ask about, so it needs a number.
 */
export const AUTO_SLIPPAGE_CAP = 20;

/** Native units kept aside for gas. Without this, a full deployment cannot pay to exit. */
export const GAS_RESERVE: Record<Chain, number> = { sol: 0.02, bsc: 0.004, base: 0.0015, eth: 0.004 };

export const EXPLORER: Record<Chain, string> = {
  sol: "https://solscan.io/tx/",
  bsc: "https://bscscan.com/tx/",
  base: "https://basescan.org/tx/",
  eth: "https://etherscan.io/tx/",
};

/**
 * The dashboard's "Refine" panel → GMGN feed filters, one min/max pair per row. These narrow
 * what the feeds *return*; they are not gates and cannot loosen one — `runGates` still runs on
 * every row that comes back, so a slack refine value costs wasted rows, never a wider risk
 * envelope. Config keys are `<key>Min` / `<key>Max`; an absent key means "no filter" (0 is a
 * real value: max dev holding 0% = dev fully out).
 *
 * `/v1/market/rank` and `/v1/trenches` describe several of these with different field names,
 * so a row carries the rank pair plus a `trenches` override where the two disagree.
 *
 * `scale` converts the UI's percent to the 0–1 ratio the API wants; `unit` turns minutes
 * into the duration string `min_created` / `max_created` require.
 */
type RefineField = {
  min: string;
  max: string;
  trenches?: { min: string; max: string };
  hi: number;
  unit?: string;
  scale?: number;
};

export const REFINE_FIELDS: Record<string, RefineField> = {
  age: { min: "min_created", max: "max_created", hi: 100_000, unit: "m" },
  liquidity: { min: "min_liquidity", max: "max_liquidity", hi: 1_000_000_000 },
  marketCap: { min: "min_marketcap", max: "max_marketcap", hi: 1_000_000_000_000 },
  fee: {
    min: "min_gas_fee",
    max: "max_gas_fee",
    trenches: { min: "min_total_fee", max: "max_total_fee" },
    hi: 1_000_000,
  },
  kol: { min: "min_renowned_count", max: "max_renowned_count", hi: 10_000 },
  smartMoney: { min: "min_smart_degen_count", max: "max_smart_degen_count", hi: 10_000 },
  top10: {
    min: "min_top10_holder_rate",
    max: "max_top10_holder_rate",
    trenches: { min: "min_top_holder_rate", max: "max_top_holder_rate" },
    hi: 100,
    scale: 0.01,
  },
  devHolding: {
    min: "min_dev_team_hold_rate",
    max: "max_dev_team_hold_rate",
    trenches: { min: "min_creator_balance_rate", max: "max_creator_balance_rate" },
    hi: 100,
    scale: 0.01,
  },
  insider: {
    min: "min_insider_rate",
    max: "max_insider_rate",
    trenches: { min: "min_insider_ratio", max: "max_insider_ratio" },
    hi: 100,
    scale: 0.01,
  },
};

/** Config values → one feed's filter params. Blank rows drop out. */
export function refineQuery(refine: Record<string, number>, feed: "rank" | "trenches" = "rank"): Record<string, string | number> {
  const q: Record<string, string | number> = {};
  for (const [key, f] of Object.entries(REFINE_FIELDS)) {
    const names = (feed === "trenches" && f.trenches) || f;
    for (const [side, api] of [["Min", names.min] as const, ["Max", names.max] as const]) {
      const v = refine?.[key + side];
      if (v === undefined) continue;
      q[api] = f.unit ? `${v}${f.unit}` : f.scale ? v * f.scale : v;
    }
  }
  return q;
}

export const DEFAULT_CONFIG: TradeConfig = {
  chain: "sol",
  mode: "paper",
  intervalMinutes: 15,
  monitorSeconds: 30,
  prompt: "",

  riskPerTradePct: 4,
  maxOpenPositions: 5,
  maxDailyLossPct: 15,
  fixedStrategy: true,
  strategy: [],
  stopLossPct: 25,
  takeProfit: [
    { at: 60, sell: 40 },
    { at: 150, sell: 30 },
    { at: 400, sell: 20 },
  ],
  trailArmPct: 45,
  trailGivebackPct: 25,
  timeStopMinutes: 180,
  timeStopMinPnlPct: 8,
  cooldownMinutes: 120,

  refine: {},
  slippagePct: 20,

  minPositionUsd: 0,
  gasReserveNative: 0,
  paperStartEquityUsd: 1000,
  walletAddress: "",
};

export const minPosition = (cfg: TradeConfig): number => cfg.minPositionUsd || MIN_POSITION_USD[cfg.chain];
export const gasReserve = (cfg: TradeConfig): number => cfg.gasReserveNative || GAS_RESERVE[cfg.chain];
/** Paper's impact cap. Live reads `slippagePct === 0` directly — that is the auto flag. */
export const slippage = (cfg: TradeConfig): number => cfg.slippagePct || AUTO_SLIPPAGE_CAP;


/**
 * Every number off the GMGN wire arrives as `unknown` — string, number, null, or absent.
 * This is the one coercion for all of them, and it lives here rather than in `market.ts`
 * so the pure layer can read a feed row without importing the HTTP client to do it.
 */
export const num = (v: unknown, d = 0): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : d;
};

/**
 * `num` for fields only one of the two feeds reports. A missing rate is not a rate of zero —
 * "no insider trading" and "this feed does not measure insider trading" are opposite readings
 * of the same 0, and the analyst is told to treat a blank as a blank.
 */
export const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

function clamp(n: unknown, lo: number, hi: number, fallback: number): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(hi, Math.max(lo, v));
}

/** Drop anything blank or unknown, clamp the rest to its row's ceiling. Negatives are not filters. */
function sanitizeRefine(input: unknown): Record<string, number> {
  const src = (input ?? {}) as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const [key, f] of Object.entries(REFINE_FIELDS))
    for (const side of ["Min", "Max"]) {
      const raw = src[key + side];
      if (raw === undefined || raw === null || raw === "") continue;
      const v = Number(raw);
      if (Number.isFinite(v)) out[key + side] = Math.min(f.hi, Math.max(0, v));
    }
  return out;
}

/** Exit-builder rows. Same clamps as the fields they replace — a rule is a risk limit. */
export function sanitizeStrategy(input: unknown, base: StrategyRule[]): StrategyRule[] {
  if (!Array.isArray(input)) return base;
  const out: StrategyRule[] = [];
  for (const r of input.slice(0, 12)) {
    const sell = clamp(r?.sell, 1, 100, 50);
    if (r?.kind === "tp") out.push({ kind: "tp", at: clamp(r.at, 5, 5000, 100), sell });
    else if (r?.kind === "sl") out.push({ kind: "sl", at: clamp(r.at, -95, -1, -50), sell });
    else if (r?.kind === "ttp")
      out.push({ kind: "ttp", at: clamp(r.at, 5, 5000, 100), dd: clamp(r.dd, 1, 90, 10), sell });
    else if (r?.kind === "tsl") out.push({ kind: "tsl", dd: clamp(r.dd, 1, 90, 20), sell });
  }
  return out;
}

/**
 * Coerce whatever arrived from the dashboard into a config we're willing to trade with.
 * Every bound here is a real safety limit, not input tidying.
 */
export function sanitizeConfig(input: Partial<TradeConfig>, base: TradeConfig = DEFAULT_CONFIG): TradeConfig {
  const chain = CHAINS.includes(input.chain as Chain) ? (input.chain as Chain) : base.chain;
  const mode: Mode = input.mode === "live" ? "live" : input.mode === "paper" ? "paper" : base.mode;

  let ladder = Array.isArray(input.takeProfit) ? input.takeProfit : base.takeProfit;
  ladder = ladder
    .map((r) => ({ at: clamp(r?.at, 5, 5000, 60), sell: clamp(r?.sell, 1, 100, 30) }))
    .sort((a, b) => a.at - b.at)
    .slice(0, 5);
  if (!ladder.length) ladder = base.takeProfit;

  return {
    chain,
    mode,
    intervalMinutes: clamp(input.intervalMinutes, 1, 1440, base.intervalMinutes),
    monitorSeconds: clamp(input.monitorSeconds, 10, 600, base.monitorSeconds),
    prompt: typeof input.prompt === "string" ? input.prompt.slice(0, 8000) : base.prompt,

    riskPerTradePct: clamp(input.riskPerTradePct, 0.5, 25, base.riskPerTradePct),
    maxOpenPositions: Math.round(clamp(input.maxOpenPositions, 1, 20, base.maxOpenPositions)),
    maxDailyLossPct: clamp(input.maxDailyLossPct, 1, 90, base.maxDailyLossPct),
    fixedStrategy: typeof input.fixedStrategy === "boolean" ? input.fixedStrategy : base.fixedStrategy,
    strategy: sanitizeStrategy(input.strategy, base.strategy),
    stopLossPct: clamp(input.stopLossPct, 5, 90, base.stopLossPct),
    takeProfit: ladder,
    trailArmPct: clamp(input.trailArmPct, 5, 1000, base.trailArmPct),
    trailGivebackPct: clamp(input.trailGivebackPct, 5, 80, base.trailGivebackPct),
    timeStopMinutes: clamp(input.timeStopMinutes, 5, 10080, base.timeStopMinutes),
    timeStopMinPnlPct: clamp(input.timeStopMinPnlPct, -50, 500, base.timeStopMinPnlPct),
    cooldownMinutes: clamp(input.cooldownMinutes, 0, 10080, base.cooldownMinutes),

    // Feed query filters, not gates — the only thing that narrows what the sweep fetches.
    refine: sanitizeRefine(input.refine),
    // 0 is not a tolerance, it is the auto flag — same convention as the two fields below.
    slippagePct: Math.round(clamp(input.slippagePct, 0, 100, base.slippagePct)),

    minPositionUsd: clamp(input.minPositionUsd, 0, 100_000, base.minPositionUsd),
    gasReserveNative: clamp(input.gasReserveNative, 0, 10, base.gasReserveNative),
    paperStartEquityUsd: clamp(input.paperStartEquityUsd, 10, 10_000_000, base.paperStartEquityUsd),
    walletAddress: typeof input.walletAddress === "string" ? input.walletAddress.trim().slice(0, 80) : base.walletAddress,
  };
}

/**
 * Live trading needs an explicit opt-in the operator sets in their own shell.
 * We never set GMGN_ALLOW_AUTOMATED_TRADES ourselves — that variable is the human's
 * consent to headless execution, so setting it from here would hollow out the barrier
 * it exists to provide. Since this process signs its own trade requests, this check is
 * the whole barrier; there is no second process left to refuse on our behalf.
 */
export function liveReady(cfg: TradeConfig): { ok: boolean; reason: string } {
  if (process.env.GMGN_ALLOW_AUTOMATED_TRADES !== "1")
    return { ok: false, reason: "GMGN_ALLOW_AUTOMATED_TRADES=1 is not set in this shell" };
  if (!process.env.GMGN_API_KEY?.trim()) return { ok: false, reason: "GMGN_API_KEY is not set" };
  if (!process.env.GMGN_PRIVATE_KEY?.trim())
    return { ok: false, reason: "GMGN_PRIVATE_KEY is not set — trade requests cannot be signed" };
  if (!cfg.walletAddress) return { ok: false, reason: "no wallet address configured" };
  return { ok: true, reason: "" };
}
