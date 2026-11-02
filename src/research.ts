import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.ts";
import { db, insert, tx } from "./db.ts";
import { log, short } from "./log.ts";
import { calibration, replayTrade, type ExitPlan } from "./replay.ts";
import { STEP_MS, type Point, type Source } from "./shadow.ts";

/**
 * Hypotheses: the model proposes, code judges, the operator decides. An idea is a rule code can
 * check on what the agent was shown (conditions over shadow_tracks.features) plus an exit plan.
 * Registering it fixes its bar; only tracks that start after it can judge it, so the test is
 * always on data no one had seen. Every registration is a try and raises the bar of the next.
 * Ideas come from the in-app research agent or from Claude Code, both through research-cli.ts.
 */

export type Op = "<" | "<=" | ">" | ">=" | "=" | "!=";
/** A field of the brief against a value, or against another field times a factor (price vs. ATH). */
export type Cond = { path: string; op: Op; value: number | string | boolean | { path: string; times: number } };
export type Exit = { sl: number; tp: { at: number; sell: number }[]; time_min: number };
/** What a test runs under, copied from Settings when the idea is registered. */
export type Setup = Exit & { drain: number; slots: number; size_sol: number };
export type Idea = { rule: string; conditions: Cond[]; exit: Exit; source: Source; parent_id: number | null };
export type Stats = { n: number; win: number | null; avg_pct: number | null; halves: number[]; friction_pct: number | null; base_avg_pct: number | null };

/** An idea is judged on its first BAR_N trades after registration. */
export const BAR_N = 30;
/** The replay is trusted once this many real trades replay, and this share agree on win or loss. */
const CAL_MIN = 10;
const CAL_AGREE = 0.9;
/** A buy lands about 4s after the decision (security read, quote): the replay buys 2 points in. */
const ENTRY_STEPS = 2;
const HALF_DAY = 12 * 3_600_000;
/** Backtests, context only, look this far back. */
const BACKTEST_MS = 7 * 86_400_000;

// ── rules (pure) ──────────────────────────────────────────────────────

const OPS: Op[] = ["<", "<=", ">", ">=", "=", "!="];
const PATH = /^[A-Za-z0-9_]{1,40}(\.[A-Za-z0-9_]{1,40}){0,4}$/;

/** A dotted field of a features row; undefined when any step is missing. */
export function field(o: unknown, path: string): unknown {
  let v: any = o;
  for (const k of path.split(".")) {
    if (v === null || typeof v !== "object") return undefined;
    v = v[k];
  }
  return v;
}

/** Whether a features row meets every condition. A missing or non-numeric field fails a comparison. */
export function matches(f: unknown, conds: Cond[]): boolean {
  return conds.every((c) => {
    const a = field(f, c.path);
    const b = typeof c.value === "object" ? Number(field(f, c.value.path)) * c.value.times : c.value;
    if (c.op === "=") return a === b;
    if (c.op === "!=") return a !== b;
    if (typeof a !== "number" || typeof b !== "number" || !Number.isFinite(a) || !Number.isFinite(b)) return false;
    return c.op === "<" ? a < b : c.op === "<=" ? a <= b : c.op === ">" ? a > b : a >= b;
  });
}

const num = (v: unknown, lo: number, hi: number) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;

/**
 * An idea as a model or a person wrote it, checked and cut to the known shape, or what is wrong
 * with it. The trust boundary: everything a model sends goes through here before it is stored.
 */
export function validate(x: any): Idea | string {
  if (!x || typeof x !== "object") return "send an object: {rule, conditions, exit, source?, parent_id?}";
  const rule = typeof x.rule === "string" ? x.rule.trim() : "";
  if (!rule || rule.length > 1000) return "rule: the idea in words, as it would go into the operator prompt, 1–1000 characters";
  if (!Array.isArray(x.conditions) || !x.conditions.length || x.conditions.length > 12) return "conditions: 1–12 of {path, op, value}";
  const conditions: Cond[] = [];
  for (const c of x.conditions) {
    const v = c?.value;
    const ref = v !== null && typeof v === "object" && PATH.test(v.path) && num(v.times, -1e6, 1e6);
    const plain = num(v, -1e15, 1e15) || typeof v === "boolean" || (typeof v === "string" && v.length <= 80);
    if (!c || !PATH.test(c.path) || !OPS.includes(c.op) || !(ref || plain))
      return `condition ${JSON.stringify(c)?.slice(0, 120)}: path like flow.1m.change_pct, op one of ${OPS.join(" ")}, value a number, string, boolean or {path, times}`;
    if (typeof v !== "number" && !ref && c.op !== "=" && c.op !== "!=") return `condition on ${c.path}: a string or boolean takes = or != only`;
    conditions.push({ path: c.path, op: c.op, value: ref ? { path: v.path, times: v.times } : v });
  }
  const e = x.exit;
  if (!e || !num(e.sl, -95, -1)) return "exit.sl: the stop, % below the fill, -95 to -1";
  if (!Array.isArray(e.tp) || !e.tp.length || e.tp.length > 4 || !e.tp.every((t: any) => num(t?.at, 1, 1000) && num(t?.sell, 0.01, 100)))
    return "exit.tp: 1–4 of {at: % above the fill, 1–1000, sell: % of the position}";
  if (Math.abs(e.tp.reduce((s: number, t: any) => s + t.sell, 0) - 100) > 0.01) return "exit.tp: the sells must add up to 100%";
  if (!Number.isInteger(e.time_min) || !num(e.time_min, 1, 60)) return "exit.time_min: whole minutes, 1–60 (a track is 60 minutes)";
  const source = x.source ?? "decision";
  if (!["decision", "rank", "migration"].includes(source)) return "source: decision, rank or migration";
  const parent = x.parent_id ?? null;
  if (parent !== null && !(Number.isInteger(parent) && db.prepare("select 1 from hypotheses where id = ?").get(parent))) return "parent_id: an earlier idea's id, or null";
  return { rule, conditions, exit: { sl: e.sl, tp: e.tp.map((t: any) => ({ at: t.at, sell: t.sell })), time_min: e.time_min }, source, parent_id: parent };
}

const plan = (s: Setup): ExitPlan => ({
  rules: [{ kind: "sl", at: s.sl, sell: 100 }, ...s.tp.map((t) => ({ kind: "tp" as const, at: t.at, sell: t.sell }))],
  timeMin: s.time_min,
  drainPct: s.drain,
});

/** A small seeded generator, so a verdict comes out the same every time it is computed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** How often the mean of `n` picks drawn at random from `pool` is below `avg`, in % (ties count half). Pure. */
export function beats(avg: number, pool: number[], n: number, draws: number, seed: number): number {
  if (pool.length < n) return 0;
  const a = [...pool];
  const r = rng(seed);
  let below = 0;
  for (let d = 0; d < draws; d++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const j = i + Math.floor(r() * (a.length - i));
      [a[i], a[j]] = [a[j]!, a[i]!];
      sum += a[i]!;
    }
    const m = sum / n;
    below += m < avg ? 1 : m === avg ? 0.5 : 0;
  }
  return (below / draws) * 100;
}

/** Draws for try `t`: enough that the bar's tail (5 / t %) holds about 20 of them. */
export const drawsFor = (t: number) => Math.min(200_000, Math.max(1_000, 400 * t));

// ── tracks ────────────────────────────────────────────────────────────

type Track = { id: number; token: string; started_at: number; features: string; end_reason: string };

/** Readable tracks of a source in [from, to), oldest first, each token's first only. */
function tracksIn(source: Source, from: number, to: number): Track[] {
  const rows = db
    .prepare(
      `select id, token, started_at, features, end_reason from shadow_tracks where source = ? and started_at >= ? and started_at < ?
       and end_reason in ('done', 'rug') and path is not null order by started_at, id`,
    )
    .all(source, from, to) as Track[];
  const seen = new Set<string>();
  return rows.filter((r) => !seen.has(r.token) && !!seen.add(r.token));
}

function tradeOn(t: Track, s: Setup) {
  const path = JSON.parse((db.prepare("select path from shadow_tracks where id = ?").get(t.id) as { path: string }).path) as Point[];
  return replayTrade(path, ENTRY_STEPS, plan(s), s.size_sol, t.end_reason === "rug");
}

/**
 * The idea run over `tracks` as the engine would: a matching token is bought when one of the
 * setup's slots is free at its start, and holds the slot until its replay sells the last of it.
 */
export function simulate(conds: Cond[], s: Setup, tracks: Track[]): { at: number; pnl: number }[] {
  const out: { at: number; pnl: number }[] = [];
  const busyUntil: number[] = [];
  for (const t of tracks) {
    if (!matches(JSON.parse(t.features), conds)) continue;
    const open = busyUntil.filter((u) => u > t.started_at).length;
    if (open >= s.slots) continue;
    const r = tradeOn(t, s);
    if (!r) continue;
    busyUntil.push(t.started_at + r.out * STEP_MS);
    out.push({ at: t.started_at, pnl: r.pnl });
  }
  return out;
}

/** The friction every test charges: the replay's mean overstatement on real trades, once it is trusted. */
export function friction(): { pct: number | null; note: string } {
  const c = calibration();
  if (c.n < CAL_MIN || c.agree / c.n < CAL_AGREE)
    return { pct: null, note: `the replay is not trusted yet: ${c.agree} of ${c.n} real trades agree (needs ${CAL_MIN}+ at ${CAL_AGREE * 100}%)` };
  return { pct: Math.max(0, c.gapPct ?? 0), note: "" };
}

function stats(trades: { at: number; pnl: number }[], fr: number | null, base: number[]): Stats {
  const pnls = trades.map((t) => t.pnl - (fr ?? 0));
  const halves = new Map<number, number>();
  trades.forEach((t, i) => halves.set(Math.floor(t.at / HALF_DAY), (halves.get(Math.floor(t.at / HALF_DAY)) ?? 0) + pnls[i]!));
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  return {
    n: trades.length,
    win: trades.length ? (pnls.filter((p) => p > 0).length / trades.length) * 100 : null,
    avg_pct: mean(pnls),
    halves: [...halves.values()],
    friction_pct: fr,
    base_avg_pct: mean(base.map((p) => p - (fr ?? 0))),
  };
}

const pools = new Map<string, number[]>();

/** Every readable track of the window replayed with the setup: what a random pick would have made. Kept per window and setup. */
function poolOf(tracks: Track[], s: Setup): number[] {
  const key = `${tracks[0]?.id}-${tracks.at(-1)?.id}-${tracks.length}-${JSON.stringify(s)}`;
  if (!pools.has(key)) {
    if (pools.size > 50) pools.clear();
    pools.set(key, tracks.map((t) => tradeOn(t, s)?.pnl).filter((p): p is number => p !== undefined));
  }
  return pools.get(key)!;
}

/** An idea on the past week's tracks: context for whoever proposes it, never a verdict. */
export function backtest(idea: Idea, now = Date.now()): Stats & { note: string } {
  const s = setupOf(idea.exit);
  const tracks = tracksIn(idea.source, now - BACKTEST_MS, now);
  const fr = friction();
  return { ...stats(simulate(idea.conditions, s, tracks), fr.pct, poolOf(tracks, s)), note: `past tracks, in sample: context only${fr.note ? `; ${fr.note}, no friction charged` : ""}` };
}

function setupOf(exit: Exit): Setup {
  const cfg = loadConfig();
  return { ...exit, drain: cfg.liquidityDrainPct, slots: cfg.maxOpenPositions, size_sol: cfg.sizeSol };
}

// ── hypotheses ────────────────────────────────────────────────────────

/** Records an idea as a try. Its bar (need_pct) is set now from its try number and never moves. */
export function register(idea: Idea, author: string, now = Date.now()): { id: number; need_pct: number; backtest: ReturnType<typeof backtest> } {
  const bt = backtest(idea, now);
  const setup = setupOf(idea.exit);
  return tx(() => {
    const id = ((db.prepare("select coalesce(max(id), 0) + 1 n from hypotheses").get() as { n: number }).n);
    const need = 100 - 5 / id;
    insert("hypotheses", {
      id, created_at: now, author: author.slice(0, 80), parent_id: idea.parent_id, rule: idea.rule, conditions: JSON.stringify(idea.conditions),
      exit: JSON.stringify(setup), source: idea.source, need_pct: need, backtest: JSON.stringify(bt), status: "testing",
    });
    return { id, need_pct: need, backtest: bt };
  });
}

type Row = { id: number; created_at: number; conditions: string; exit: string; source: Source; need_pct: number };

/**
 * Judges every idea still testing on the tracks that started after it was registered. Code decides
 * at the BAR_N-th trade: passed when the mean after friction is above 0, every half-day is above 0,
 * and the mean beats need_pct % of random picks of as many tokens from the same source and window.
 */
export function judge(now = Date.now()): { id: number; status: string }[] {
  const done: { id: number; status: string }[] = [];
  const fr = friction();
  for (const h of db.prepare("select id, created_at, conditions, exit, source, need_pct from hypotheses where status = 'testing'").all() as Row[]) {
    const s = JSON.parse(h.exit) as Setup;
    const tracks = tracksIn(h.source, h.created_at, now);
    const trades = simulate(JSON.parse(h.conditions), s, tracks).slice(0, BAR_N);
    if (trades.length < BAR_N || fr.pct === null) {
      const note = trades.length < BAR_N ? `${trades.length} of ${BAR_N} trades` : `${BAR_N} trades, waiting: ${fr.note}`;
      db.prepare("update hypotheses set result = ? where id = ?").run(JSON.stringify({ n: trades.length, note }), h.id);
      continue;
    }
    const pool = poolOf(tracks.filter((t) => t.started_at <= trades.at(-1)!.at), s);
    const st = stats(trades, fr.pct, pool);
    const draws = drawsFor(h.id);
    // Friction moves the idea and the random picks alike: compared before it.
    const rnd = beats(trades.reduce((a, t) => a + t.pnl, 0) / BAR_N, pool, BAR_N, draws, h.id);
    const passed = st.avg_pct! > 0 && st.halves.every((x) => x > 0) && rnd >= h.need_pct;
    const status = passed ? "passed" : "failed";
    db.prepare("update hypotheses set result = ?, status = ?, decided_at = ? where id = ?")
      .run(JSON.stringify({ ...st, rnd_pct: rnd, draws, pool_n: pool.length }), status, now, h.id);
    done.push({ id: h.id, status });
  }
  return done;
}

/** The operator's no: logged with its numbers, never tried again as new. */
export function drop(id: number, now = Date.now()): boolean {
  return Number(db.prepare("update hypotheses set status = 'dropped', decided_at = ? where id = ? and status in ('testing', 'passed', 'failed')").run(now, id).changes) > 0;
}

export type Try = { id: number; created_at: number; author: string; parent_id: number | null; rule: string; conditions: Cond[]; exit: Setup; source: Source; need_pct: number; backtest: unknown; result: any; status: string; decided_at: number | null; notes: string | null };

/** Every try, newest first, as the dashboard, the CLI and the research agent read them. */
export function tries(limit = 200): Try[] {
  return (db.prepare("select * from hypotheses order by id desc limit ?").all(limit) as any[]).map((h) => ({
    ...h,
    conditions: JSON.parse(h.conditions),
    exit: JSON.parse(h.exit),
    backtest: h.backtest ? JSON.parse(h.backtest) : null,
    result: h.result ? JSON.parse(h.result) : null,
  }));
}

/** The rounds tried before hypotheses existed, as failed tries, so no model proposes them again. Once. */
export function seedTries(): void {
  if ((db.prepare("select count(*) n from hypotheses").get() as { n: number }).n) return;
  const at = (d: string) => Date.parse(d);
  const base = (sl: number, tp: number): Setup => ({ sl, tp: [{ at: tp, sell: 100 }], time_min: 30, drain: 55, slots: 2, size_sol: 0.1 });
  const r2: Cond[] = [
    { path: "migrated", op: "=", value: true },
    { path: "pool_exchange", op: "=", value: "pump_amm" },
    { path: "total_fee", op: ">=", value: 3 },
    { path: "top_bundler_trader_percentage", op: "<=", value: 0.3 },
    { path: "top_10_holder_rate", op: "<=", value: 0.25 },
    { path: "flow.1m.change_pct", op: ">", value: 0 },
  ];
  const seeds = [
    {
      created_at: at("2026-10-28T00:00:00Z"), parent_id: null, exit: base(-40, 20),
      rule: "Round 1: migrated pump_amm token, 1h swaps 1000–1999, price up over the last minute.",
      conditions: [
        { path: "migrated", op: "=", value: true }, { path: "pool_exchange", op: "=", value: "pump_amm" },
        { path: "flow.1h.swaps", op: ">=", value: 1000 }, { path: "flow.1h.swaps", op: "<=", value: 1999 }, { path: "flow.1m.change_pct", op: ">", value: 0 },
      ],
      result: { n: 27, win: 52, note: "live paper 14 of 27 won, −$26.56; the backtest's 33 of 34 was the best-looking small subset, fitted to noise" },
    },
    {
      created_at: at("2026-10-29T00:00:00Z"), parent_id: null, exit: base(-30, 15), conditions: r2,
      rule: "Round 2: migrated pump_amm, total fee ≥ 3 SOL, bundlers ≤ 30%, top 10 ≤ 25%, price up over the last minute.",
      result: { n: 7, win: 57, avg_pct: -3.1, note: "live 7 trades, 4 won, −3.1% a trade; calibrated 30s replay 70% won, −2.2% a trade" },
    },
    {
      created_at: at("2026-10-29T12:00:00Z"), parent_id: 2, exit: base(-30, 15),
      conditions: [...r2, { path: "price_usd", op: ">=", value: { path: "ath_price_usd", times: 0.7 } }],
      rule: "Round 2 + ATH: as round 2, and price at least 70% of the all-time high.",
      result: { win: 73, avg_pct: -1.6, note: "calibrated 30s replay 73% won, −1.6% a trade; live it would have kept 1 of 7 trades, which lost" },
    },
    {
      created_at: at("2026-10-29T18:00:00Z"), parent_id: null, exit: base(-50, 15), conditions: [],
      rule: "Round 3: the brief's GMGN signal counts add up to 10 or more.",
      result: { n: 16, win: 70, note: "look-ahead: totals read later held signals fired after the decision; on the at-decision totals 69–71% won, −1.6% to +1.0% a trade, no dose-response" },
    },
  ];
  tx(() =>
    seeds.forEach((s, i) =>
      insert("hypotheses", {
        id: i + 1, created_at: s.created_at, author: "claude-code", parent_id: s.parent_id, rule: s.rule, conditions: JSON.stringify(s.conditions),
        exit: JSON.stringify(s.exit), source: "decision", need_pct: 100 - 5 / (i + 1), result: JSON.stringify(s.result), status: "failed",
        decided_at: s.created_at, notes: "tried before hypotheses existed; numbers from the 28–30 Oct research",
      }),
    ),
  );
}

// ── running the CLI from the engine ───────────────────────────────────

const CLI = fileURLToPath(new URL("./research-cli.ts", import.meta.url));
const children = new Map<string, ChildProcess>();

/**
 * Runs `research-cli.ts <cmd>` as its own process: SQLite reads are synchronous, and a heavy
 * research query must never hold up the exit loop. One of each at a time, killed after `maxMs`.
 */
export function runCli(cmd: "judge" | "agent", maxMs: number): boolean {
  if (children.has(cmd)) return false;
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, cmd], { stdio: ["ignore", "ignore", "pipe"], env: process.env });
  children.set(cmd, child);
  let err = "";
  child.stderr?.on("data", (d) => (err = (err + d).slice(-400)));
  const kill = setTimeout(() => child.kill(), maxMs);
  child.on("exit", (code, signal) => {
    clearTimeout(kill);
    children.delete(cmd);
    if (code !== 0) log("warn", `Research ${cmd} ended ${signal ? `by ${signal}` : `with code ${code}`}${err ? `: ${short(err)}` : ""}`);
  });
  child.on("error", (e) => log("warn", `Research ${cmd} did not start: ${short(e)}`));
  return true;
}

export const cliRunning = (cmd: "judge" | "agent"): boolean => children.has(cmd);
