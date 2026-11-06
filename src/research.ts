import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig, type Config, type Rule } from "./config.ts";
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
  // rank and migration are no longer sampled: an idea on them would never meet a track to judge it.
  if (!["decision", "signal"].includes(source)) return "source: decision or signal";
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
let poolsOf: unknown = null;

/** Every readable track of the window replayed with the setup: what a random pick would have made. Kept per window and setup. */
function poolOf(tracks: Track[], s: Setup): number[] {
  const key = `${tracks[0]?.id}-${tracks.at(-1)?.id}-${tracks.length}-${JSON.stringify(s)}`;
  if (poolsOf !== db) (pools.clear(), (poolsOf = db));
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

/** What makes two ideas the same try: their conditions as a set, the exit and the source. Rule words, Settings and parent do not. Pure. */
export const sameIdea = (conds: Cond[], exit: Pick<Exit, "sl" | "tp" | "time_min">, source: string): string =>
  JSON.stringify([
    [...new Set(conds.map((c) => JSON.stringify([c.path, c.op, c.value])))].sort(),
    exit.sl,
    exit.tp.map((t) => [t.at, t.sell]).sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!),
    exit.time_min,
    source,
  ]);

/**
 * Records an idea as a try, or says which try it repeats: a try is never re-run as new, whatever
 * became of it. Its bar (need_pct) is set now from its try number and never moves.
 */
export function register(idea: Idea, author: string, now = Date.now()): string | { id: number; need_pct: number; backtest: ReturnType<typeof backtest> } {
  const key = sameIdea(idea.conditions, idea.exit, idea.source);
  const past = db.prepare("select id, status, conditions, exit, source from hypotheses order by id").all() as { id: number; status: string; conditions: string; exit: string; source: string }[];
  const same = past.find((h) => sameIdea(JSON.parse(h.conditions), JSON.parse(h.exit), h.source) === key);
  if (same) return `already tried as #${same.id} (${same.status}): a try is never re-run as new; change a condition or the exit to try a variant`;
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
  for (const h of db.prepare("select * from hypotheses where status in ('paper', 'live', 'kept')").all() as Full[]) {
    const r = resultOf(h);
    const mode = h.status === "paper" ? "paper" : "live";
    if (h.status !== "kept" && !r[mode]?.verdict) {
      const v = prove(h, mode, fr, now);
      if (v) done.push({ id: h.id, status: `${mode} ${v}` });
    } else if (h.status !== "paper") decayWatch(h, fr, now);
  }
  return done;
}

// ── the proposed change ───────────────────────────────────────────────

const WORDS: Record<Op, [string, string]> = { // [against a number, against another field]
  "<": ["below", "below"], "<=": ["or less", "at most"], ">": ["above", "above"], ">=": ["or more", "at least"], "=": ["", "equal to"], "!=": ["not", "not equal to"],
};

/** The operator prompt an idea asks for, written from its conditions: what goes into Settings. Pure. */
export function promptOf(conds: Cond[]): string {
  const say = (c: Cond) => {
    if (typeof c.value === "object") return `${c.path} is ${WORDS[c.op][1]} ${c.value.times === 1 ? "" : `${c.value.times} times `}${c.value.path}`;
    const v = String(c.value);
    return c.op === "<" || c.op === ">" ? `${c.path} is ${WORDS[c.op][0]} ${v}` : c.op === "=" ? `${c.path} is ${v}` : c.op === "!=" ? `${c.path} is not ${v}` : `${c.path} is ${v} ${WORDS[c.op][0]}`;
  };
  return ["Buy only when all of these hold:", ...conds.map((c) => `- ${say(c)}`), "Skip everything else."].join("\n");
}

const signed = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v)}%`;
/** An exit plan in words, rules in a fixed order, so two equal plans read the same. */
function planText(rules: Pick<Rule, "kind" | "at" | "sell">[]): string {
  const part = (kind: "sl" | "tp", rs: typeof rules) =>
    !rs.length ? `no ${kind.toUpperCase()}` : rs.length === 1
      ? `${kind === "tp" ? "one TP" : "SL"} ${signed(rs[0]!.at)}${kind === "tp" ? ` selling ${rs[0]!.sell}%` : ""}`
      : `${kind.toUpperCase()} ${rs.map((r) => signed(r.at)).join(" / ")} selling ${rs.map((r) => `${r.sell}%`).join(" / ")}`;
  return `${part("sl", rules.filter((r) => r.kind === "sl").sort((a, b) => b.at - a.at))} · ${part("tp", rules.filter((r) => r.kind === "tp").sort((a, b) => a.at - b.at))}`;
}

/** The exit fields Settings must hold for an idea's test to run its exit: each as it is now and as the idea needs it. */
export function exitFields(cfg: Config, s: Exit): { label: string; from: string; to: string }[] {
  const want = [{ kind: "sl" as const, at: s.sl, sell: 100 }, ...s.tp.map((t) => ({ kind: "tp" as const, at: t.at, sell: t.sell }))];
  return [
    { label: "Who sets take profit and stop loss", from: cfg.exitMode === "agent" ? "Agent decides" : "Fixed plan", to: "Fixed plan" },
    { label: "Fixed plan", from: planText(cfg.plan), to: planText(want) },
    { label: "Time stop", from: `${cfg.timeStopMinutes} min`, to: `${s.time_min} min` },
  ];
}

// ── proving it: paper, then a small live stake ────────────────────────

/** Where the operator can take an idea. Paper and live run on Settings as saved: the engine as today. */
export type Move = "paper" | "cancel" | "live" | "keep" | "drop" | "undrop";

type Full = Row & { status: string; decided_at: number | null; result: string | null; paper_config_at: number | null; live_config_at: number | null; decay_at: number | null };
const full = (id: number) => db.prepare("select * from hypotheses where id = ?").get(id) as Full | undefined;
const resultOf = (h: Full): Record<string, any> => (h.result ? JSON.parse(h.result) : {});
/** The last Settings save, and the one after `at` (when the version saved at `at` stopped being in force). */
const lastSave = () => (db.prepare("select max(at) at from config_history").get() as { at: number | null }).at;
const nextSave = (at: number) => (db.prepare("select min(at) at from config_history where at > ?").get(at) as { at: number | null }).at;

/** The idea whose paper test, or live stake before its verdict, is running: Settings hold its version, so the rest wait. */
export const inTest = (except = 0) =>
  db
    .prepare(
      `select id, status from hypotheses where id != ?
       and (status = 'paper' or (status = 'live' and json_extract(result, '$.live.verdict') is null)) order by id limit 1`,
    )
    .get(except) as { id: number; status: "paper" | "live" } | undefined;
/** Passed ideas on decided tokens, in the order they passed: the line for the one paper test. */
export const paperLine = (): number[] =>
  (db.prepare("select id from hypotheses where status = 'passed' and source = 'decision' order by decided_at, id").all() as { id: number }[]).map((r) => r.id);
/** Another idea whose paper or live test ran on the Settings version saved at `at`: then that version is not this idea's. */
export const usedBy = (at: number, id: number): number | null =>
  (db.prepare("select id from hypotheses where id != ? and ? in (paper_config_at, live_config_at)").get(id, at) as { id: number } | undefined)?.id ?? null;

/**
 * The operator's move on an idea, checked against where it stands; an error, or null. Nothing
 * here edits Settings: a test runs on the version the operator saved, from when they press it.
 *   passed → paper (paper mode, saved after it passed, a version no other test ran on; one test
 *     at a time, and passed ideas take their turn in the order they passed)
 *   paper → live (it held on paper; live mode, saved after that; one at a time)
 *   live → kept (it held on live fills) · paper or live → cancel (back one step)
 *   any → drop · a drop made here → undrop
 */
export function move(id: number, to: Move, now = Date.now()): string | null {
  const h = full(id);
  if (!h) return "no idea with that id";
  const r = resultOf(h);
  const cfg = loadConfig();
  const mode = cfg.mode;
  const save = lastSave() ?? 0;
  const set = (status: string, extra: Record<string, unknown> = {}, result = r) => {
    const cols = Object.keys(extra).map((k) => `, ${k} = ?`).join("");
    db.prepare(`update hypotheses set status = ?, decided_at = ?, result = ?${cols} where id = ?`)
      .run(status, now, JSON.stringify(result), ...(Object.values(extra) as (number | null)[]), id);
    return null;
  };
  const busy = (status: string) => (db.prepare("select id from hypotheses where status = ? and id != ?").get(status, id) as { id: number } | undefined)?.id;
  if (to === "drop") return h.status === "dropped" ? "already dropped" : set("dropped", {}, { ...r, dropped_from: h.status, dropped_by: "operator" });
  if (to === "undrop") {
    if (h.status !== "dropped" || r["dropped_by"] !== "operator") return "only a drop made by hand can be undone";
    const { dropped_from, dropped_by: _, ...rest } = r;
    return set(dropped_from, {}, rest);
  }
  if (to === "paper") {
    if (h.status !== "passed") return "only an idea that passed goes to paper";
    if (h.source !== "decision") return "only an idea on decided tokens goes on paper: the engine does not brief sampled tokens to the agent";
    const other = inTest(id);
    if (other) return `#${other.id} is ${other.status === "paper" ? "on paper" : "on its live stake"}: one test at a time, #${id} waits its turn`;
    const head = paperLine()[0];
    if (head !== id) return `#${head} passed first and goes on paper first: drop it to let #${id} go ahead`;
    if (mode !== "paper") return "switch Settings to paper mode first";
    if (save <= (h.decided_at ?? 0)) return "save the rule and its exit in Settings first: the test runs on that version";
    const used = usedBy(save, id);
    if (used) return `Settings still hold the version #${used} was tested on: save #${id}'s prompt and exits first`;
    const off = exitFields(cfg, JSON.parse(h.exit)).filter((f) => f.from !== f.to);
    if (off.length) return `set the exit fields in Settings first: ${off.map((f) => f.label.toLowerCase()).join(", ")}`;
    return set("paper", { paper_config_at: save }, { ...r, paper: { n: 0 } });
  }
  if (to === "live") {
    if (h.status !== "paper" || r["paper"]?.verdict !== "holds") return "only an idea that held on paper goes live";
    if (mode !== "live") return "switch Settings to live mode, at a small size, first";
    if (save <= (r["paper"].at ?? 0)) return "save Settings for the live stake first: the test runs on that version";
    const other = busy("live");
    if (other) return `#${other} is live: one live test at a time`;
    return set("live", { live_config_at: save }, { ...r, live: { n: 0 } });
  }
  if (to === "keep") return h.status === "live" && r["live"]?.verdict === "holds" ? set("kept") : "only an idea that held on live fills is kept";
  if (to === "cancel") {
    // The version stays marked as this idea's test, so no other idea is tested on it.
    if (h.status === "paper") return set("passed", {}, { ...r, paper: undefined });
    if (h.status === "live" && !r["live"]?.verdict) return set("paper", {}, { ...r, live: undefined });
    return "only a running paper or live test can be cancelled";
  }
  return "unknown move";
}

/** How much worse a live fill came in than its quote, in % (buy: paid more; sell: got less). Pure. */
export const adverseGap = (side: "buy" | "sell", price: number, quoted: number) => (side === "buy" ? price / quoted - 1 : 1 - price / quoted) * 100;

/** Agent picks against the rule over decided tracks in [from, to): where the two agree and where they part. */
function agreement(conds: Cond[], from: number, to: number) {
  const rows = db
    .prepare(
      `select s.started_at at, s.token, s.features, d.action from shadow_tracks s join decisions d on d.id = s.decision_id
       where s.source = 'decision' and s.started_at >= ? and s.started_at < ? order by s.started_at`,
    )
    .all(from, to) as { at: number; token: string; features: string; action: string }[];
  const out = { decided: rows.length, agentBuys: 0, bothBuy: 0, ruleOnly: 0, differ: [] as { at: number; token: string; symbol: unknown; agent: string; rule: boolean }[] };
  for (const r of rows) {
    const f = JSON.parse(r.features);
    const rule = matches(f, conds);
    const buy = r.action === "buy";
    out.agentBuys += buy ? 1 : 0;
    out.bothBuy += buy && rule ? 1 : 0;
    out.ruleOnly += !buy && rule ? 1 : 0;
    if (buy !== rule) out.differ.push({ at: r.at, token: r.token, symbol: f.symbol ?? null, agent: r.action, rule });
  }
  out.differ = out.differ.slice(-8);
  return out;
}

/**
 * A paper or live test: the first BAR_N positions opened while the tested Settings version was in
 * force, judged on their real fills by the forward test's bar. Holds: the operator takes the next
 * step. Fades: dropped by code. A save of Settings mid-test pauses it: later trades are another version.
 */
function prove(h: Full, mode: "paper" | "live", fr: { pct: number | null }, now: number): string | null {
  const from = (mode === "paper" ? h.paper_config_at : h.live_config_at)!;
  const until = nextSave(from) ?? Infinity;
  const r = resultOf(h);
  const ps = db
    .prepare(
      `select p.id, p.opened_at, p.status, p.cost_usd cost, (select sum(pnl_usd) from trades t where t.position_id = p.id and t.side = 'sell') pnl
       from positions p where p.mode = ? and p.opened_at >= ? and p.opened_at < ? order by p.opened_at limit ?`,
    )
    .all(mode, from, until, BAR_N) as { id: number; opened_at: number; status: string; cost: number; pnl: number | null }[];
  const closed = ps.filter((p) => p.status === "closed" && p.cost > 0);
  const conds = JSON.parse(h.conditions) as Cond[];
  const gaps = (db
    .prepare(
      `select t.side, t.price_usd price, t.quote_price_usd quoted from trades t join positions p on p.id = t.position_id
       where p.mode = 'live' and p.opened_at >= ? and p.opened_at < ? and t.quote_price_usd > 0`,
    )
    .all(from, until) as { side: "buy" | "sell"; price: number; quoted: number }[]).map((g) => adverseGap(g.side, g.price, g.quoted));
  const base = {
    of: BAR_N, version_at: from, paused_at: until <= now ? until : null, agreement: agreement(conds, from, Math.min(until, now)),
    fill_gap_pct: gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null, at: now,
  };
  if (ps.length < BAR_N || closed.length < BAR_N) {
    db.prepare("update hypotheses set result = ? where id = ?").run(JSON.stringify({ ...r, [mode]: { ...base, n: closed.length } }), h.id);
    return null;
  }
  const trades = closed.map((p) => ({ at: p.opened_at, pnl: ((p.pnl ?? 0) / p.cost) * 100 }));
  const st = stats(trades, 0, []);
  const s = JSON.parse(h.exit) as Setup;
  // Real fills carry their costs; random picks are replays, so they pay the measured friction.
  const pool = poolOf(tracksIn(h.source, from, trades.at(-1)!.at + 1), s).map((p) => p - (fr.pct ?? 0));
  const draws = drawsFor(h.id);
  const rnd = beats(st.avg_pct!, pool, BAR_N, draws, h.id + 1000);
  const verdict = st.avg_pct! > 0 && st.halves.every((x) => x > 0) && rnd >= h.need_pct ? "holds" : "fades";
  const result = { ...r, [mode]: { ...base, ...st, friction_pct: null, rnd_pct: rnd, draws, pool_n: pool.length, verdict } };
  if (verdict === "fades") {
    db.prepare("update hypotheses set status = 'dropped', decided_at = ?, result = ? where id = ?").run(now, JSON.stringify({ ...result, dropped_from: mode, dropped_by: "code" }), h.id);
    const next = paperLine()[0];
    log("warn", `Research: #${h.id} faded on ${mode} fills (${st.avg_pct!.toFixed(1)}% a trade over ${BAR_N}) — dropped.${next ? ` #${next} is next in line for paper.` : ""}`);
  } else {
    db.prepare("update hypotheses set result = ? where id = ?").run(JSON.stringify(result), h.id);
    log("info", `Research: #${h.id} held on ${mode} fills (${st.avg_pct!.toFixed(1)}% a trade over ${BAR_N})${mode === "paper" ? " — a small live stake is your call." : " — keeping it is your call."}`);
  }
  return verdict;
}

/**
 * The decay watch, on ideas live or kept: over the last BAR_N live positions since it went live,
 * a mean at or below 0, or a fill gap above the friction, flags it once and says so. It never
 * edits Settings.
 */
function decayWatch(h: Full, fr: { pct: number | null }, now: number): void {
  const ps = db
    .prepare(
      `select p.id, p.cost_usd cost, (select sum(pnl_usd) from trades t where t.position_id = p.id and t.side = 'sell') pnl
       from positions p where p.mode = 'live' and p.status = 'closed' and p.opened_at >= ? order by p.closed_at desc limit ?`,
    )
    .all(h.live_config_at ?? now, BAR_N) as { id: number; cost: number; pnl: number | null }[];
  if (ps.length < BAR_N) return;
  const avg = ps.reduce((a, p) => a + (p.cost > 0 ? ((p.pnl ?? 0) / p.cost) * 100 : 0), 0) / ps.length;
  const ids = ps.map((p) => p.id).join(",");
  const gaps = (db.prepare(`select side, price_usd price, quote_price_usd quoted from trades where position_id in (${ids}) and quote_price_usd > 0`).all() as {
    side: "buy" | "sell"; price: number; quoted: number;
  }[]).map((g) => adverseGap(g.side, g.price, g.quoted));
  const gap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null;
  const decayed = avg <= 0 || (gap !== null && fr.pct !== null && gap > fr.pct);
  const r = { ...resultOf(h), decay: { n: ps.length, avg_pct: avg, fill_gap_pct: gap, friction_pct: fr.pct, decayed, at: now } };
  db.prepare("update hypotheses set result = ?, decay_at = coalesce(decay_at, ?) where id = ?").run(JSON.stringify(r), decayed ? now : null, h.id);
  if (decayed && !h.decay_at)
    log("warn", `Decay watch: #${h.id} — the last ${BAR_N} live trades average ${avg.toFixed(1)}%${gap !== null ? `, fill gap ${gap.toFixed(2)}%` : ""}. Settings are unchanged: your call.`);
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
        id: i + 1, created_at: s.created_at, author: "seed", parent_id: s.parent_id, rule: s.rule, conditions: JSON.stringify(s.conditions),
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
  if (cmd === "agent") agentStartedAt = Date.now();
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

/** On the engine's exit: a child would outlive its kill timer, and an agent run would keep spending. */
export function stopCli(): void {
  for (const c of children.values()) c.kill();
}

/** Whether `judge` has anything to do: an idea testing, on paper, live or kept. */
export const judgeDue = (): boolean => !!db.prepare("select 1 from hypotheses where status in ('testing', 'paper', 'live', 'kept') limit 1").get();

/** The research agent runs on its own this often; Claude Code can run one any time with `research-cli.ts agent`. */
export const RESEARCH_EVERY_MS = 86_400_000;
/** When this process last started an agent run: a run that dies before its agent_runs row must not be retried every check. */
let agentStartedAt = 0;

/** When the daily research run is next due: a day after the last research run started, one from the CLI included. */
export function nextResearchAt(): number {
  const last = (db.prepare("select max(started_at) at from agent_runs where kind = 'research'").get() as { at: number | null }).at ?? 0;
  return Math.max(last, agentStartedAt) + RESEARCH_EVERY_MS;
}

/** Whether the daily research run is due now, with a model key to run it. */
export const researchDue = (now = Date.now()): boolean => !!process.env.OPENROUTER_API_KEY && nextResearchAt() <= now;

// ── the research agent's own settings ─────────────────────────────────

/** Reads (ledger_query, test_rule) a research run may make; register_hypothesis is never one of them. */
export const RESEARCH_READS = 40;
/** Model steps a research run may take: a read a step, then the register and the report. */
export const RESEARCH_STEPS = RESEARCH_READS + 2;
/** The model a run falls back to when neither the research row nor OPENROUTER_MODEL names one. */
export const FALLBACK_MODEL = "anthropic/claude-sonnet-4.5";

/**
 * The research agent's own settings: the 'research' row in `settings`, apart from the trading
 * config. Changing it is no Settings version: config_history gains no row and no test pauses.
 */
export type ResearchSettings = { model: string };
const cleanModel = (v: unknown): string => (typeof v === "string" ? v.trim().slice(0, 120) : "");

export function researchSettings(): ResearchSettings {
  const row = db.prepare("select value from settings where key = 'research'").get() as { value: string } | undefined;
  try {
    return { model: cleanModel(row ? JSON.parse(row.value)?.model : "") };
  } catch {
    return { model: "" };
  }
}

export function saveResearchSettings(input: unknown): ResearchSettings {
  const s = { model: cleanModel((input as { model?: unknown } | null)?.model) };
  db.prepare("insert or replace into settings (key, value, updated_at) values ('research', ?, ?)").run(JSON.stringify(s), Date.now());
  return s;
}

/** The model a research run uses: its own, else OPENROUTER_MODEL, else FALLBACK_MODEL. Never the trading agent's. */
export const researchModel = (): string => researchSettings().model || process.env.OPENROUTER_MODEL || FALLBACK_MODEL;
