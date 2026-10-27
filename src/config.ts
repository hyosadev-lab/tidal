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
  /** Fetch filters, `<field>Min` / `<field>Max` (see FILTERS). Absent = no limit on that side. */
  filters: Record<string, number>;
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
    filters: cleanFilters(input.filters),
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

export function saveConfig(cfg: Config): void {
  db.prepare("insert or replace into settings (key, value, updated_at) values ('config', ?, ?)").run(JSON.stringify(cfg), Date.now());
}

// ── fetch filters ─────────────────────────────────────────────────────

/**
 * The Fetch filters modal: GMGN trending's filters, one min/max pair per key, in GMGN's own units
 * ($K, % of supply, fees in SOL; `scale` turns them into GMGN's $ and 0–1 ratios, age is minutes).
 * `api` is the rank param stem, each one checked live to narrow the result; `fields` is the value
 * on a trending row, then on a signal row. Initial liquidity has no rank param (GMGN ignores every
 * name tried), so like everything on the signal feed it is checked on the row. Signal rows carry
 * 1h volume, transactions and viewers as 0, so those bounds pass them. They narrow what reaches
 * the agent; the risk check still runs on every buy.
 */
const FILTERS: Record<string, { api?: string; fields: string[]; hi: number; scale?: number }> = {
  age: { api: "created", fields: ["creation_timestamp", "created_timestamp", "open_timestamp"], hi: 100_000 },
  liquidity: { api: "liquidity", fields: ["liquidity"], hi: 1e9, scale: 1000 },
  initialLiquidity: { fields: ["initial_liquidity"], hi: 1e9, scale: 1000 },
  marketCap: { api: "marketcap", fields: ["market_cap"], hi: 1e9, scale: 1000 },
  athMarketCap: { api: "history_highest_marketcap", fields: ["history_highest_market_cap", "ath"], hi: 1e9, scale: 1000 },
  volume: { api: "volume", fields: ["volume"], hi: 1e9, scale: 1000 },
  swaps: { api: "swaps", fields: ["swaps"], hi: 1e9 },
  fee: { api: "gas_fee", fields: ["gas_fee", "total_fee"], hi: 1e6 },
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

function cleanFilters(input: unknown): Record<string, number> {
  const src = (input ?? {}) as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const [key, f] of Object.entries(FILTERS))
    for (const side of ["Min", "Max"]) {
      const raw = src[key + side];
      if (raw === undefined || raw === null || raw === "") continue;
      const v = Number(raw);
      if (Number.isFinite(v)) out[key + side] = Math.min(f.hi, Math.max(0, v));
    }
  return out;
}

/** "marketCapMin" → the FILTERS entry, its key, and whether it is the lower bound. */
const bound = (k: string) => ({ key: k.slice(0, -3), min: k.endsWith("Min") });

/** A bound in GMGN's unit: $, a 0–1 ratio, or minutes for age. */
const gmgnUnit = (key: string, v: number) => v * (FILTERS[key]!.scale ?? 1);

export function rankFilters(cfg: Config): Record<string, string | number> {
  const q: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(cfg.filters)) {
    const { key, min } = bound(k);
    const api = FILTERS[key]?.api;
    if (api) q[`${min ? "min" : "max"}_${api}`] = key === "age" ? `${v}m` : gmgnUnit(key, v);
  }
  return q;
}

/** The signal route only takes market cap and fee bounds; `inFilters` checks the rest on its rows. */
export function signalFilters(cfg: Config): Record<string, number> {
  const f = cfg.filters;
  const out: Record<string, number> = {};
  if (f["marketCapMin"] !== undefined) out["mc_min"] = gmgnUnit("marketCap", f["marketCapMin"]);
  if (f["marketCapMax"] !== undefined) out["mc_max"] = gmgnUnit("marketCap", f["marketCapMax"]);
  if (f["feeMin"] !== undefined) out["total_fee_min"] = f["feeMin"];
  if (f["feeMax"] !== undefined) out["total_fee_max"] = f["feeMax"];
  return out;
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
 * Whether a feed row is inside every bound set. Trending rows already passed GMGN's own check, so
 * this catches what GMGN cannot: initial liquidity, and signal rows. A row without the field passes.
 */
export function inFilters(row: Record<string, unknown>, cfg: Config, now = Date.now()): boolean {
  for (const [k, v] of Object.entries(cfg.filters)) {
    const { key, min } = bound(k);
    const got = rowValue(row, key, now);
    const lim = key === "age" ? v : gmgnUnit(key, v);
    if (got !== undefined && (min ? got < lim : got > lim)) return false;
  }
  return true;
}
