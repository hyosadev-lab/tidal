import { db } from "./db.ts";

/**
 * The operator's config: the Settings board's fields, their defaults, and the clamp every value
 * passes through. The clamps are risk limits, not input tidying — a stored value can narrow a
 * limit, never widen one past these. Stored whole as JSON in `settings` under 'config', read
 * fresh at the start of every cycle, so an edit applies from the next one.
 */

export type Rule = { kind: "tp" | "sl"; at: number; sell: number };

export type Config = {
  mode: "paper" | "live";
  paperStartUsd: number;
  /** A wait's recheck time is clamped to this. */
  maxWaitMinutes: number;
  /** A sold token can come back after this. */
  cooldownMinutes: number;
  sizeSol: number;
  maxOpenPositions: number;
  /** % of the day's starting equity; past it buying pauses. Exits keep running. */
  maxDailyLossPct: number;
  /** After the daily loss pause: auto lifts it at the next midnight, manual waits for Resume. */
  lossResume: "auto" | "manual";
  /** 0 = auto: Jupiter picks the tolerance per route. */
  slippagePct: number;
  /** fixed: every position gets `plan`. agent: the agent writes one per buy, clamped to `agent`. */
  exitMode: "fixed" | "agent";
  /** % PnL from entry → % of the original qty. TP sells and SL sells each add up to 100. */
  plan: Rule[];
  agent: { slTightest: number; slWidest: number; maxTps: number; firstTpMin: number; noPlan: "fixed" | "skip" };
  timeStopMinutes: number;
  /** Sell everything when Jupiter's liquidity falls this % below the entry reading. */
  liquidityDrainPct: number;
  /** Empty = OPENROUTER_MODEL. */
  model: string;
  /** Tool calls per agent run; null = no limit. */
  toolCalls: number | null;
  /** Model steps per agent run; null = no limit. */
  maxSteps: number | null;
  /** The operator's selection policy, appended to the system prompt. */
  prompt: string;
  /** Fetch filters on 1h trending, `<field>Min` / `<field>Max` (see FILTERS). Absent = no limit on that side. */
  filters: Record<string, number>;
  /** The same, on the signal list: market cap and fee only. */
  signalFilters: Record<string, number>;
  /** GMGN signal types the signal list fetches, one group each (SIGNAL_TYPES); none = the list is off. */
  signalTypes: number[];
};

export const DEFAULTS: Config = {
  mode: "paper",
  paperStartUsd: 1000,
  maxWaitMinutes: 60,
  cooldownMinutes: 120,
  sizeSol: 0.1,
  maxOpenPositions: 2,
  maxDailyLossPct: 20,
  lossResume: "auto",
  slippagePct: 0,
  exitMode: "fixed",
  plan: [
    { kind: "sl", at: -25, sell: 100 },
    { kind: "tp", at: 60, sell: 40 },
    { kind: "tp", at: 150, sell: 30 },
    { kind: "tp", at: 400, sell: 30 },
  ],
  agent: { slTightest: -10, slWidest: -40, maxTps: 4, firstTpMin: 20, noPlan: "fixed" },
  timeStopMinutes: 30,
  liquidityDrainPct: 55,
  model: "",
  toolCalls: 12,
  maxSteps: 24,
  prompt: "",
  filters: {},
  signalFilters: {},
  signalTypes: [12, 18], // smart money buy, pump claim: picked off the bought-token data (4 Nov 2026)
};

const clamp = (v: unknown, lo: number, hi: number, dflt: number): number => {
  const n = typeof v === "number" || typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

/** Both halves of a plan sell exactly 100% of the position, so no position opens without a full exit. */
export function exitsFully(rules: Rule[]): boolean {
  const sum = (k: Rule["kind"]) => rules.reduce((t, r) => t + (r.kind === k ? r.sell : 0), 0);
  return Math.abs(sum("tp") - 100) < 0.01 && Math.abs(sum("sl") - 100) < 0.01;
}

/** Cleans a rule list; null when what is left would not exit fully. */
export function cleanPlan(input: unknown): Rule[] | null {
  if (!Array.isArray(input)) return null;
  const rules: Rule[] = input.slice(0, 8).flatMap((r): Rule[] =>
    r?.kind === "tp"
      ? [{ kind: "tp", at: clamp(r.at, 1, 10_000, 100), sell: clamp(r.sell, 1, 100, 100) }]
      : r?.kind === "sl"
        ? [{ kind: "sl", at: clamp(r.at, -95, -1, -25), sell: clamp(r.sell, 1, 100, 100) }]
        : [],
  );
  return exitsFully(rules) ? rules : null;
}

/** A limit the operator may leave empty: null or "" = no limit, absent = the default. */
const limit = (v: unknown, lo: number, hi: number, dflt: number | null): number | null =>
  v === null || v === "" ? null : v === undefined ? dflt : Math.round(clamp(v, lo, hi, dflt ?? hi));

export function sanitize(input: Record<string, any>): Config {
  const d = DEFAULTS;
  const a = input.agent ?? {};
  const slTightest = clamp(a.slTightest, -50, -1, d.agent.slTightest);
  return {
    mode: input.mode === "live" ? "live" : "paper",
    paperStartUsd: clamp(input.paperStartUsd, 10, 10_000_000, d.paperStartUsd),
    maxWaitMinutes: Math.round(clamp(input.maxWaitMinutes, 1, 1440, d.maxWaitMinutes)),
    cooldownMinutes: clamp(input.cooldownMinutes, 0, 10_080, d.cooldownMinutes),
    sizeSol: clamp(input.sizeSol, 0.001, 100, d.sizeSol),
    maxOpenPositions: Math.round(clamp(input.maxOpenPositions, 1, 20, d.maxOpenPositions)),
    maxDailyLossPct: clamp(input.maxDailyLossPct, 1, 90, d.maxDailyLossPct),
    lossResume: input.lossResume === "manual" ? "manual" : "auto",
    slippagePct: clamp(input.slippagePct, 0, 50, d.slippagePct),
    exitMode: input.exitMode === "agent" ? "agent" : "fixed",
    plan: cleanPlan(input.plan) ?? d.plan,
    agent: {
      slTightest,
      slWidest: clamp(a.slWidest, -95, slTightest, Math.min(slTightest, d.agent.slWidest)),
      maxTps: Math.round(clamp(a.maxTps, 1, 8, d.agent.maxTps)),
      firstTpMin: clamp(a.firstTpMin, 1, 1000, d.agent.firstTpMin),
      noPlan: a.noPlan === "skip" ? "skip" : "fixed",
    },
    timeStopMinutes: clamp(input.timeStopMinutes, 1, 10_080, d.timeStopMinutes),
    liquidityDrainPct: clamp(input.liquidityDrainPct, 1, 99, d.liquidityDrainPct),
    model: typeof input.model === "string" ? input.model.trim().slice(0, 120) : d.model,
    toolCalls: limit(input.toolCalls, 0, 100, d.toolCalls),
    maxSteps: limit(input.maxSteps, 1, 100, d.maxSteps),
    prompt: typeof input.prompt === "string" ? input.prompt.slice(0, 8000) : d.prompt,
    filters: cleanFilters(input.filters, "trending"),
    signalFilters: cleanFilters(input.signalFilters, "signals"),
    signalTypes: Array.isArray(input.signalTypes)
      ? SIGNAL_TYPES.filter((t) => input.signalTypes.map(Number).includes(t))
      : d.signalTypes,
  };
}

/** The config as stored, sanitised; the defaults are written on first read. */
export function loadConfig(): Config {
  const row = db.prepare("select value from settings where key = 'config'").get() as { value: string } | undefined;
  if (row) {
    try {
      return sanitize(JSON.parse(row.value));
    } catch {
      // A hand-edited row that does not parse falls back to the defaults below, and is replaced.
    }
  }
  saveConfig(DEFAULTS);
  return DEFAULTS;
}

/**
 * Stores the config, and appends it to config_history: the version every trade and track is scored
 * under. A save that changes nothing is no new version (it would pause a paper or live test).
 */
export function saveConfig(cfg: Config): void {
  const value = JSON.stringify(cfg);
  const at = Date.now();
  db.prepare("insert or replace into settings (key, value, updated_at) values ('config', ?, ?)").run(value, at);
  const last = db.prepare("select value from config_history order by at desc limit 1").get() as { value: string } | undefined;
  if (last?.value !== value) db.prepare("insert or replace into config_history (at, value) values (?, ?)").run(at, value);
}

// ── fetch filters ─────────────────────────────────────────────────────

/**
 * GMGN's signal types the token_signal route takes (names: snapshot.ts SIGNAL_NAMES). It refuses
 * 14–16 (large buy, multi buy, multi large buy: HTTP 400 "not supported", 4 Nov 2026), and the
 * whole request with them. 21 (banker claim) is left out for now: Base only, always empty on Solana.
 */
export const SIGNAL_TYPES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 17, 18, 19, 20];

/** The two lists the entry loop fetches; each has its own filters. */
export type Feed = "trending" | "signals";

/**
 * The Fetch filters modal: one min/max pair per key, in GMGN's own units ($K, % of supply, fees
 * in SOL; `scale` turns them into GMGN's $ and 0–1 ratios, age is minutes). `api` is the 1h rank
 * param stem, each one checked live to narrow the result; `signal` the token signal route's (it
 * takes market cap and total fee only, so those are all the signal list offers). `fields` is the
 * value on a trending row, then on a signal row. A bound with no param is checked on the row only
 * (initial liquidity on trending: GMGN ignores every name tried). They narrow what reaches the
 * agent; the risk check still runs on every buy.
 */
const FILTERS: Record<string, { api?: string; signal?: string; fields: string[]; hi: number; scale?: number }> = {
  age: { api: "created", fields: ["creation_timestamp", "open_timestamp", "created_timestamp"], hi: 100_000 },
  liquidity: { api: "liquidity", fields: ["liquidity"], hi: 1e9, scale: 1000 },
  initialLiquidity: { fields: ["initial_liquidity"], hi: 1e9, scale: 1000 },
  marketCap: { api: "marketcap", signal: "mc", fields: ["market_cap"], hi: 1e9, scale: 1000 },
  athMarketCap: { api: "history_highest_marketcap", fields: ["history_highest_market_cap"], hi: 1e9, scale: 1000 },
  volume: { api: "volume", fields: ["volume"], hi: 1e9, scale: 1000 },
  swaps: { api: "swaps", fields: ["swaps"], hi: 1e9 },
  fee: { api: "gas_fee", signal: "total_fee", fields: ["gas_fee", "total_fee"], hi: 1e6 },
  holders: { api: "holder_count", fields: ["holder_count"], hi: 1e9 },
  botDegens: { api: "bot_degen_count", fields: ["bot_degen_count"], hi: 1e6 },
  viewing: { api: "visiting_count", fields: ["visiting_count"], hi: 1e6 },
  smartMoney: { api: "smart_degen_count", fields: ["smart_degen_count"], hi: 10_000 },
  kol: { api: "renowned_count", fields: ["renowned_count"], hi: 10_000 },
  top10: { api: "top10_holder_rate", fields: ["top_10_holder_rate"], hi: 100, scale: 0.01 },
  devHolding: { api: "dev_team_hold_rate", fields: ["dev_team_hold_rate"], hi: 100, scale: 0.01 },
  insider: { api: "insider_rate", fields: ["rat_trader_amount_rate"], hi: 100, scale: 0.01 },
  bundler: { api: "bundler_rate", fields: ["bundler_rate", "bundler_trader_amount_rate"], hi: 100, scale: 0.01 },
  phishing: { api: "entrapment_ratio", fields: ["entrapment_ratio"], hi: 100, scale: 0.01 },
  sniper: { api: "top70_sniper_hold_rate", fields: ["top70_sniper_hold_rate"], hi: 100, scale: 0.01 },
};

function cleanFilters(input: unknown, feed: Feed): Record<string, number> {
  const src = (input ?? {}) as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const [key, f] of Object.entries(FILTERS))
    for (const side of ["Min", "Max"]) {
      const raw = src[key + side];
      if (raw === undefined || raw === null || raw === "" || (feed === "signals" && !f.signal)) continue;
      const v = Number(raw);
      if (Number.isFinite(v)) out[key + side] = Math.min(f.hi, Math.max(0, v));
    }
  return out;
}

/** "marketCapMin" → the FILTERS entry, its key, and whether it is the lower bound. */
const bound = (k: string) => ({ key: k.slice(0, -3), min: k.endsWith("Min") });

/** A bound in GMGN's unit: $, a 0–1 ratio, or minutes for age. */
const gmgnUnit = (key: string, v: number) => v * (FILTERS[key]!.scale ?? 1);

/** Trending's bounds as rank params, `min_<stem>` / `max_<stem>`; bounds with no param are left to `inFilters`. */
export function rankFilters(cfg: Config): Record<string, string | number> {
  const q: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(cfg.filters)) {
    const { key, min } = bound(k);
    const name = FILTERS[key]?.api;
    if (name) q[`${min ? "min" : "max"}_${name}`] = key === "age" ? `${v}m` : gmgnUnit(key, v);
  }
  return q;
}

/** The signal list's bounds as one token_signal group's params, `<stem>_min` / `<stem>_max`. */
export function signalFilters(cfg: Config): Record<string, number> {
  const q: Record<string, number> = {};
  for (const [k, v] of Object.entries(cfg.signalFilters)) {
    const { key, min } = bound(k);
    const name = FILTERS[key]?.signal;
    if (name) q[`${name}_${min ? "min" : "max"}`] = gmgnUnit(key, v);
  }
  return q;
}

/** The row's value for a filter in GMGN's unit (age in minutes); undefined when the row lacks it. */
function rowValue(row: Record<string, unknown>, key: string, now: number): number | undefined {
  for (const field of FILTERS[key]!.fields) {
    const raw = row[field];
    if (raw === null || raw === undefined || raw === "" || !Number.isFinite(Number(raw))) continue;
    if (key !== "age") return Number(raw);
    if (Number(raw) > 0) return (now / 1000 - Number(raw)) / 60;
  }
  return undefined;
}

/**
 * Whether a feed row is inside every bound of its feed's filters. The rows already passed GMGN's
 * own check, so this catches what GMGN cannot: bounds with no param. A row without the field passes.
 */
export function inFilters(row: Record<string, unknown>, filters: Record<string, number>, now = Date.now()): boolean {
  for (const [k, v] of Object.entries(filters)) {
    const { key, min } = bound(k);
    const got = rowValue(row, key, now);
    const lim = key === "age" ? v : gmgnUnit(key, v);
    if (got !== undefined && (min ? got < lim : got > lim)) return false;
  }
  return true;
}

/**
 * pump.fun's launchpads in GMGN's names: their tokens start on a pump curve and migrate to PumpSwap,
 * the pools the exit loop and shadow tracks read on-chain. Only the first two seen so far (3 Nov 2026).
 */
export const PUMP = ["Pump.fun", "pump_mayhem", "pump_agent", "pump_mayhem_agent"];

/**
 * A pump.fun launch on a pump curve or a PumpSwap pool: the exchange check keeps any other pool out.
 * Signal rows only: the signal route has no platform param, while trending's `platforms` does it.
 */
export const isPump = (r: any): boolean =>
  (PUMP.includes(r?.launchpad_platform) || r?.launchpad === "pump") && ["pump", "pump_amm"].includes(r?.exchange);
