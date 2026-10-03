import type { Chain, Mode, StrategyRule, TradeConfig } from "./types.ts";
import { CHAINS, AUTO_SLIPPAGE_CAP, GAS_RESERVE, MIN_POSITION_USD } from "./chains.ts";
import { clamp, num } from "./num.ts";

/**
 * The operator's settings: what the dashboard may set, what it defaults to, and the clamp
 * every input passes through. Those clamps are safety limits rather than input tidying — a
 * stored or typed value can never widen a risk limit, only narrow one.
 *
 * Persistence of the config itself lives with the rest of the persisted state, in `data/`.
 */

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

  positionSizeNative: {},
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
  cooldownMinutes: 120,

  refine: {},
  slippagePct: 0,

  gasReserveNative: 0,
  paperStartEquityUsd: 1000,
  walletAddress: "",
};

export const minPosition = (cfg: TradeConfig): number => MIN_POSITION_USD[cfg.chain];
/** The fixed buy size for the chain in play. 0 = the operator has not set one, so nothing trades. */
export const tradeSize = (cfg: TradeConfig): number => cfg.positionSizeNative[cfg.chain] ?? 0;
export const gasReserve = (cfg: TradeConfig): number => cfg.gasReserveNative || GAS_RESERVE[cfg.chain];
/** Paper's impact cap. Live reads `slippagePct === 0` directly — that is the auto flag. */
export const slippage = (cfg: TradeConfig): number => cfg.slippagePct || AUTO_SLIPPAGE_CAP;

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

/**
 * Buy size per chain. Kept per chain because 0.1 is a small buy on SOL and a large one on ETH,
 * so switching chains must not carry the number over. A missing or unusable entry stays missing:
 * an unset chain does not trade rather than trading a guessed size.
 */
function sanitizeSizes(input: unknown, base: Partial<Record<Chain, number>>): Partial<Record<Chain, number>> {
  if (input === undefined || input === null) return base;
  const src = (input ?? {}) as Record<string, unknown>;
  const out: Partial<Record<Chain, number>> = {};
  for (const chain of CHAINS) {
    const v = Number(src[chain]);
    if (Number.isFinite(v) && v > 0) out[chain] = Math.min(1000, v);
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

    positionSizeNative: sanitizeSizes(input.positionSizeNative, base.positionSizeNative),
    maxOpenPositions: Math.round(clamp(input.maxOpenPositions, 1, 20, base.maxOpenPositions)),
    maxDailyLossPct: clamp(input.maxDailyLossPct, 1, 90, base.maxDailyLossPct),
    fixedStrategy: typeof input.fixedStrategy === "boolean" ? input.fixedStrategy : base.fixedStrategy,
    strategy: sanitizeStrategy(input.strategy, base.strategy),
    stopLossPct: clamp(input.stopLossPct, 5, 90, base.stopLossPct),
    takeProfit: ladder,
    trailArmPct: clamp(input.trailArmPct, 5, 1000, base.trailArmPct),
    trailGivebackPct: clamp(input.trailGivebackPct, 5, 80, base.trailGivebackPct),
    timeStopMinutes: clamp(input.timeStopMinutes, 5, 10080, base.timeStopMinutes),
    cooldownMinutes: clamp(input.cooldownMinutes, 0, 10080, base.cooldownMinutes),

    // Feed query filters, not gates — the only thing that narrows what the sweep fetches.
    refine: sanitizeRefine(input.refine),
    // 0 is not a tolerance, it is the auto flag — same convention as the two fields below.
    slippagePct: Math.round(clamp(input.slippagePct, 0, 100, base.slippagePct)),

    gasReserveNative: clamp(input.gasReserveNative, 0, 10, base.gasReserveNative),
    paperStartEquityUsd: clamp(input.paperStartEquityUsd, 10, 10_000_000, base.paperStartEquityUsd),
    walletAddress: typeof input.walletAddress === "string" ? input.walletAddress.trim().slice(0, 80) : base.walletAddress,
  };
}

/**
 * Chain and wallet are what an open position is sold on — `broker.sell` and the monitor read
 * both off the config, not off the position — so neither may move while one is open. Returns
 * the refusal, or null when the change is safe.
 */
export function chainLock(cfg: TradeConfig, openPositions: number, input: Partial<TradeConfig>): string | null {
  if (!openPositions) return null;
  const chain = input.chain !== undefined && input.chain !== cfg.chain;
  const wallet =
    typeof input.walletAddress === "string" && input.walletAddress.trim().toLowerCase() !== cfg.walletAddress.toLowerCase();
  if (!chain && !wallet) return null;
  return `Close the ${openPositions} open position${openPositions > 1 ? "s" : ""} first — they are sold on ${cfg.chain.toUpperCase()} from the current wallet, so chain and wallet stay put until then.`;
}

/**
 * Live trading needs an explicit opt-in the operator sets in their own shell.
 * We never set GMGN_ALLOW_AUTOMATED_TRADES ourselves — that variable is the human's
 * consent to headless execution, so setting it from here would hollow out the barrier
 * it exists to provide. Since this process signs its own trade requests, this check is
 * the whole barrier; there is no second process left to refuse on our behalf.
 *
 * Solana is the exception, by the operator's decision: it swaps through Jupiter, signed with
 * the wallet's own key, and putting `SOLANA_PRIVATE_KEY` in the environment is the consent.
 */
export function liveReady(cfg: TradeConfig): { ok: boolean; reason: string } {
  if (!process.env.GMGN_API_KEY?.trim()) return { ok: false, reason: "GMGN_API_KEY is not set" };
  if (!cfg.walletAddress) return { ok: false, reason: "no wallet address configured" };
  if (cfg.chain === "sol")
    return process.env.SOLANA_PRIVATE_KEY?.trim()
      ? { ok: true, reason: "" }
      : { ok: false, reason: "SOLANA_PRIVATE_KEY is not set — Jupiter swaps cannot be signed" };
  if (process.env.GMGN_ALLOW_AUTOMATED_TRADES !== "1")
    return { ok: false, reason: "GMGN_ALLOW_AUTOMATED_TRADES=1 is not set in this shell" };
  if (!process.env.GMGN_PRIVATE_KEY?.trim())
    return { ok: false, reason: "GMGN_PRIVATE_KEY is not set — trade requests cannot be signed" };
  return { ok: true, reason: "" };
}

