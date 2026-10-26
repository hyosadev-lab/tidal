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
  /** % of the day's starting equity; past it buying pauses until the next day. Exits keep running. */
  maxDailyLossPct: number;
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
  toolCalls: number;
  maxSteps: number;
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
  sizeSol: 0.12,
  maxOpenPositions: 2,
  maxDailyLossPct: 20,
  slippagePct: 1,
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
  toolCalls: 6,
  maxSteps: 10,
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
    toolCalls: Math.round(clamp(input.toolCalls, 0, 30, d.toolCalls)),
    maxSteps: Math.round(clamp(input.maxSteps, 1, 40, d.maxSteps)),
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
  db.prepare("insert or replace into settings (key, value, updated_at) values ('config', ?, ?)").run(JSON.stringify(DEFAULTS), Date.now());
  return DEFAULTS;
}

// ── fetch filters ─────────────────────────────────────────────────────

/**
 * The Fetch filters modal → GMGN query params, one min/max pair per row. Rank names verified on
 * the old feed code; `scale` turns the UI's percent into GMGN's 0–1 ratio, `unit` minutes into
 * the duration string min_created/max_created want. They only narrow what is fetched — the
 * risk check still runs on every buy.
 */
const FILTERS: Record<string, { min: string; max: string; hi: number; unit?: string; scale?: number }> = {
  age: { min: "min_created", max: "max_created", hi: 100_000, unit: "m" },
  marketCap: { min: "min_marketcap", max: "max_marketcap", hi: 1e12 },
  liquidity: { min: "min_liquidity", max: "max_liquidity", hi: 1e9 },
  fee: { min: "min_gas_fee", max: "max_gas_fee", hi: 1e6 },
  smartMoney: { min: "min_smart_degen_count", max: "max_smart_degen_count", hi: 10_000 },
  kol: { min: "min_renowned_count", max: "max_renowned_count", hi: 10_000 },
  top10: { min: "min_top10_holder_rate", max: "max_top10_holder_rate", hi: 100, scale: 0.01 },
  devHolding: { min: "min_dev_team_hold_rate", max: "max_dev_team_hold_rate", hi: 100, scale: 0.01 },
  insider: { min: "min_insider_rate", max: "max_insider_rate", hi: 100, scale: 0.01 },
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

export function rankFilters(cfg: Config): Record<string, string | number> {
  const q: Record<string, string | number> = {};
  for (const [key, f] of Object.entries(FILTERS))
    for (const [side, api] of [["Min", f.min], ["Max", f.max]] as const) {
      const v = cfg.filters[key + side];
      if (v !== undefined) q[api] = f.unit ? `${v}${f.unit}` : f.scale ? v * f.scale : v;
    }
  return q;
}

// ponytail: the signal route only takes market cap and fee bounds, so the other filters do not
// narrow signal rows; they still reach the agent. Filter them off the row's own `data` if that costs.
export function signalFilters(cfg: Config): Record<string, number> {
  const f = cfg.filters;
  const out: Record<string, number> = {};
  if (f["marketCapMin"] !== undefined) out["mc_min"] = f["marketCapMin"];
  if (f["marketCapMax"] !== undefined) out["mc_max"] = f["marketCapMax"];
  if (f["feeMin"] !== undefined) out["total_fee_min"] = f["feeMin"];
  if (f["feeMax"] !== undefined) out["total_fee_max"] = f["feeMax"];
  return out;
}
