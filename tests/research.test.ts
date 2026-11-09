import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyVersion, loadConfig, saveConfig, versionAt } from "../src/config.ts";
import { db, insert, openDb } from "../src/db.ts";
import { adverseGap, beats, drawsFor, exitFields, judge, matches, move, promptOf, FALLBACK_MODEL, nextResearchAt, register, researchDue, RESEARCH_EVERY_MS, researchModel, researchSettings, sameIdea, saveResearchSettings, tries, validate, type Idea } from "../src/research.ts";
import { agent, query } from "../src/research-cli.ts";
import type { Point } from "../src/shadow.ts";

const DEEP = 1e9;
const idea = (over: Record<string, unknown> = {}) => ({
  rule: "Good tokens only.",
  conditions: [{ path: "good", op: "=", value: true }],
  exit: { sl: -30, tp: [{ at: 15, sell: 100 }], time_min: 30 },
  ...over,
});

/** Registers an idea that must be new, and gives back its try. */
function reg(x: unknown, author: string, now?: number) {
  const r = register(validate(x) as Idea, author, now);
  assert.ok(typeof r !== "string", String(r));
  return r;
}

test("rules: fields by path, a field against another, a missing field fails", () => {
  const f = { migrated: true, flow: { "1m": { change_pct: 4 } }, price_usd: 8, ath_price_usd: 10 };
  assert.ok(matches(f, [{ path: "migrated", op: "=", value: true }, { path: "flow.1m.change_pct", op: ">", value: 0 }]));
  assert.ok(matches(f, [{ path: "price_usd", op: ">=", value: { path: "ath_price_usd", times: 0.7 } }]));
  assert.ok(!matches(f, [{ path: "price_usd", op: ">=", value: { path: "ath_price_usd", times: 0.9 } }]));
  assert.ok(!matches(f, [{ path: "holder_count", op: ">", value: 0 }]));
  assert.ok(!matches(f, [{ path: "flow.5m.change_pct", op: "<", value: 100 }]));
});

test("validate: the shape a model must send, and what it is told when it does not", () => {
  openDb(":memory:");
  const ok = validate(idea({ extra: "dropped" }));
  assert.ok(typeof ok !== "string");
  assert.deepEqual(Object.keys(ok).sort(), ["conditions", "exit", "parent_id", "rule", "source"]);
  assert.equal(ok.source, "decision");
  for (const [bad, why] of [
    [idea({ conditions: [] }), /conditions/],
    [idea({ conditions: [{ path: "a;drop", op: "=", value: 1 }] }), /path/],
    [idea({ conditions: [{ path: "name", op: ">", value: "x" }] }), /= or !=/],
    [idea({ exit: { sl: -30, tp: [{ at: 15, sell: 60 }], time_min: 30 } }), /add up to 100/],
    [idea({ exit: { sl: -30, tp: [{ at: 15, sell: 100 }], time_min: 90 } }), /1–60/],
    [idea({ source: "kline" }), /source/],
    [idea({ source: "rank" }), /source: decision or signal/], // no longer sampled: nothing would ever judge it
    [idea({ parent_id: 7 }), /parent_id/],
  ] as const)
    assert.match(validate(bad) as string, why);
});

test("random picks: the share of draws an average beats, the same every time", () => {
  const pool = Array.from({ length: 100 }, (_, i) => i);
  assert.equal(beats(1000, pool, 30, 2000, 1), 100);
  assert.equal(beats(-1, pool, 30, 2000, 1), 0);
  const mid = beats(49.5, pool, 30, 2000, 7);
  assert.ok(mid > 40 && mid < 60, String(mid));
  assert.equal(beats(49.5, pool, 30, 2000, 7), mid);
  assert.equal(drawsFor(1), 1000);
  assert.equal(drawsFor(20), 8000); // the bar's tail (0.25%) holds 20 draws
});

let seq = 0;
/** A decided token's track, and when `cost` is given, the real trade bought on it. */
/** A decided token's track, and with `real` its position: bought under the current version (one is recorded if none), or `version`. */
function decided(at: number, features: object, path: Point[], real?: { pnl: number; reason: string; mode?: string; version?: number | null }) {
  const token = `T${seq++}`;
  insert("tokens", { address: token, first_seen_at: 1 });
  const d = insert("decisions", { run_id: insert("agent_runs", { started_at: at, model: "m", status: "ok" }), token, action: real ? "buy" : "skip" });
  insert("shadow_tracks", {
    token, source: "decision", decision_id: d, features: JSON.stringify(features), started_at: at, ended_at: at + 3_600_000,
    end_reason: "done", path: JSON.stringify(path), ret_30m: path.at(-1)![0],
  });
  if (!real) return;
  const p = insert("positions", {
    token, decision_id: d, entry_snapshot_id: insert("token_snapshots", { token, taken_at: at, kind: "entry", price_usd: 1, raw: "{}" }),
    mode: real.mode ?? "paper", status: "closed", opened_at: at + 4_000, closed_at: at + 60_000, close_reason: real.reason, entry_price_usd: 1, cost_usd: 10, original_qty: "1", qty: "0",
    config_at: real.version !== undefined ? real.version : (versionAt() ?? applyVersion()),
    time_stop_min: loadConfig().timeStopMinutes, drain_pct: loadConfig().liquidityDrainPct, size_sol: loadConfig().sizeSol,
  });
  insert("exit_rules", { position_id: p, seq: 0, kind: "sl", at_pct: -30, sell_pct: 100 });
  insert("exit_rules", { position_id: p, seq: 1, kind: "tp", at_pct: 15, sell_pct: 100 });
  insert("trades", { position_id: p, at: at + 60_000, side: "sell", qty: "1", price_usd: 1, usd: 10 + real.pnl / 10, pnl_usd: real.pnl / 10, reason: real.reason });
}
const UP: Point[] = [[0, DEEP], [0, DEEP], [0, DEEP], [20, DEEP], [20, DEEP]];
const DOWN: Point[] = [[0, DEEP], [0, DEEP], [0, DEEP], [-40, DEEP], [-40, DEEP]];

test("judge: waits for a trusted replay, then decides at the 30th trade on tracks after registration only", () => {
  openDb(":memory:");
  const t0 = Date.UTC(2026, 10, 2, 0, 0);
  for (let i = 0; i < 40; i++) decided(t0 - 86_400_000 + i * 60_000, { good: true }, DOWN); // before: never judged
  const good = reg(idea(), "m", t0);
  const bad = reg(idea({ rule: "Bad tokens.", conditions: [{ path: "good", op: "=", value: false }] }), "m", t0);
  assert.equal(tries().find((x) => x.id === good.id)!.status, "testing");
  for (let i = 0; i < 80; i++) decided(t0 + 60_000 + i * 600_000, { good: i % 2 === 0 }, i % 2 === 0 ? UP : DOWN);

  assert.deepEqual(judge(t0 + 2 * 86_400_000), []); // no real trade replays yet: the replay is not trusted
  assert.match(tries().find((x) => x.id === good.id)!.result.note, /not trusted/);

  for (let i = 0; i < 10; i++) decided(t0 - 3 * 86_400_000 + i * 60_000, { good: true }, UP, { pnl: 19.9, reason: "tp" });
  assert.deepEqual(judge(t0 + 2 * 86_400_000), [{ id: good.id, status: "passed" }, { id: bad.id, status: "failed" }]);
  const g = tries().find((x) => x.id === good.id)!;
  assert.equal(g.result.n, 30);
  assert.ok(g.result.avg_pct > 19 && g.result.win === 100 && g.result.rnd_pct > 99, JSON.stringify(g.result));
  assert.ok(g.result.halves.every((h: number) => h > 0));
  assert.equal(tries().find((x) => x.id === bad.id)!.result.win, 0);

  assert.equal(move(good.id, "drop"), null);
  assert.equal(tries().find((x) => x.id === good.id)!.status, "dropped");
  assert.equal(move(good.id, "drop"), "already dropped");
  assert.equal(move(good.id, "undrop"), null);
  assert.equal(tries().find((x) => x.id === good.id)!.status, "passed");
});

test("judge: a ledger with no Settings version still decides, once 10 real trades replay", () => {
  openDb(":memory:");
  const t0 = Date.UTC(2026, 10, 2, 0, 0);
  const good = reg(idea(), "m", t0);
  for (let i = 0; i < 60; i++) decided(t0 + 60_000 + i * 600_000, { good: i % 2 === 0 }, i % 2 === 0 ? UP : DOWN);
  for (let i = 0; i < 10; i++) decided(t0 - 86_400_000 + i * 60_000, { good: true }, UP, { pnl: 19.9, reason: "tp", version: null });
  assert.equal(versionAt(), null); // only Apply makes one, and nothing has passed yet
  assert.deepEqual(judge(t0 + 2 * 86_400_000), [{ id: good.id, status: "passed" }]);
});

test("ledger_query: one select on a read-only connection, cut short when it runs long", () => {
  const ro = new DatabaseSync(":memory:");
  ro.exec("create table t (n integer); with recursive s(n) as (select 1 union all select n + 1 from s where n < 500) insert into t select n from s;");
  assert.match(String(query(ro, "delete from t")), /Only one select/);
  assert.match(String(query(ro, "select * from pragma_table_info('t') -- pragma")), /Only one select/);
  const r = query(ro, "select n from t") as { rows: unknown[]; cut?: string };
  assert.equal(r.rows.length, 200);
  assert.match(r.cut!, /aggregate/);
  assert.match(String(query(ro, "select nope from t")), /SQL error/);
});

test("fill gap: what a live fill paid over its quote, either side", () => {
  assert.ok(Math.abs(adverseGap("buy", 1.02, 1) - 2) < 1e-9);
  assert.ok(Math.abs(adverseGap("sell", 0.98, 1) - 2) < 1e-9);
  assert.ok(Math.abs(adverseGap("sell", 1.01, 1) + 1) < 1e-9);
});

const trusted = (t: number) => { for (let i = 0; i < 10; i++) decided(t + i * 60_000, { good: true }, UP, { pnl: 19.9, reason: "tp" }); };

test("apply, paper, then live: each step the operator's, each judged at 30 trades on its own fills", () => {
  openDb(":memory:");
  const t0 = Date.UTC(2026, 10, 2, 0, 0);
  trusted(t0 - 3 * 86_400_000); // bought under the defaults, recorded as a version
  const h = reg(idea(), "m", t0).id;
  for (let i = 0; i < 40; i++) decided(t0 + 60_000 + i * 600_000, { good: i % 4 !== 3 }, i % 4 !== 3 ? UP : DOWN);
  judge(t0 + 86_400_000);
  assert.equal(tries()[0]!.status, "passed");

  assert.match(move(h, "paper", t0 + 86_400_000)!, /press Apply first/);
  assert.equal(move(h, "apply", t0 + 86_400_000 + 1), null); // writes the idea into Settings, records it
  const cfg = loadConfig();
  assert.deepEqual([cfg.prompt, cfg.exitMode, cfg.plan, cfg.timeStopMinutes], [
    "Buy only when all of these hold:\n- good is true\nSkip everything else.", "fixed",
    [{ kind: "sl", at: -30, sell: 100 }, { kind: "tp", at: 15, sell: 100 }], 30,
  ]);
  const paperVersion = versionAt();
  assert.equal(paperVersion, t0 + 86_400_000 + 1);
  assert.equal(move(h, "apply", t0 + 86_400_000 + 5), null); // again: Settings equal it, no second version
  assert.equal(versionAt(), paperVersion);
  assert.equal(move(h, "live"), "only an idea that held on paper goes live");
  const paperAt = t0 + 86_400_000 + 2;
  assert.equal(move(h, "paper", paperAt), null);
  // 30 paper trades on the agent's buys (all the rule's too), 2 rule matches the agent skipped, 50 losers it skipped.
  for (let i = 0; i < 30; i++) decided(paperAt + 60_000 + i * 1_800_000, { good: true, symbol: `B${i}` }, UP, { pnl: 5, reason: "tp" });
  for (let i = 0; i < 2; i++) decided(paperAt + 90_000 + i * 1_800_000, { good: true, symbol: `S${i}` }, UP);
  for (let i = 0; i < 50; i++) decided(paperAt + 120_000 + i * 1_000_000, { good: false }, DOWN);
  judge(paperAt + 3 * 86_400_000);
  const p = tries()[0]!.result.paper;
  assert.equal(p.verdict, "holds", JSON.stringify(p));
  assert.deepEqual([p.n, p.agreement.agentBuys, p.agreement.bothBuy, p.agreement.ruleOnly, p.agreement.differ.length], [30, 30, 30, 2, 2]);
  assert.equal(tries()[0]!.status, "paper");

  assert.match(move(h, "live")!, /live mode/);
  saveConfig({ ...loadConfig(), mode: "live" }); // the operator switches to live, at a small size: no version yet
  assert.equal(versionAt(), null);
  const liveAt = paperAt + 3 * 86_400_000 + 1;
  assert.equal(move(h, "live", liveAt), null); // Go live records them
  assert.equal(versionAt(), liveAt);
  for (let i = 0; i < 30; i++) decided(liveAt + 60_000 + i * 1_800_000, { good: true }, DOWN, { pnl: -4, reason: "sl", mode: "live" });
  judge(liveAt + 3 * 86_400_000);
  const r = tries()[0]!;
  assert.deepEqual([r.status, r.result.live.verdict, r.result.dropped_by], ["dropped", "fades", "code"]);
  assert.equal(move(h, "undrop"), "only a drop made by hand can be undone");
});

test("a hand edit pauses a test: trades bought while Settings match no version count for none", () => {
  openDb(":memory:");
  const exit = JSON.stringify({ sl: -30, tp: [{ at: 15, sell: 100 }], time_min: 30, drain: 55, slots: 2, size_sol: 0.1 });
  insert("hypotheses", { id: 1, created_at: 1, author: "m", rule: "r", conditions: JSON.stringify(idea().conditions), exit, need_pct: 95, status: "passed", decided_at: 1, result: "{}" });
  assert.equal(move(1, "apply", 10), null);
  assert.equal(move(1, "paper", 20), null);
  for (let i = 0; i < 5; i++) decided(100 + i * 60_000, { good: true }, UP, { pnl: 5, reason: "tp" });
  saveConfig({ ...loadConfig(), sizeSol: 0.2 }); // a hand edit: no version current
  for (let i = 0; i < 5; i++) decided(1_000_000 + i * 60_000, { good: true }, UP, { pnl: 5, reason: "tp", version: versionAt() });
  judge(86_400_000);
  assert.deepEqual([tries()[0]!.result.paper.n, tries()[0]!.result.paper.paused], [5, true]);
  saveConfig({ ...loadConfig(), sizeSol: 0.1 }); // undone by hand: the version is current, the test goes on
  judge(86_400_000);
  assert.equal(tries()[0]!.result.paper.paused, false);
});

test("decay watch: a kept idea whose last 30 live trades lose is flagged once, Settings untouched", () => {
  openDb(":memory:");
  const t0 = Date.UTC(2026, 10, 5, 0, 0);
  const cfg = loadConfig();
  insert("config_history", { at: t0, value: JSON.stringify({ ...cfg, mode: "live" }) });
  insert("hypotheses", {
    id: 1, created_at: t0, author: "m", rule: "r", conditions: "[]", exit: JSON.stringify({ sl: -30, tp: [{ at: 15, sell: 100 }], time_min: 30, drain: 55, slots: 2, size_sol: 0.1 }),
    need_pct: 95, status: "kept", live_config_at: t0, result: "{}",
  });
  for (let i = 0; i < 30; i++) decided(t0 + i * 600_000, { good: true }, DOWN, { pnl: -2, reason: "sl", mode: "live" });
  judge(t0 + 86_400_000);
  const h = db.prepare("select decay_at, result from hypotheses where id = 1").get() as { decay_at: number; result: string };
  assert.equal(h.decay_at, t0 + 86_400_000);
  assert.equal(JSON.parse(h.result).decay.decayed, true);
  judge(t0 + 2 * 86_400_000);
  assert.equal((db.prepare("select decay_at from hypotheses where id = 1").get() as { decay_at: number }).decay_at, t0 + 86_400_000);
  assert.equal(loadConfig().mode, cfg.mode);
});

test("proposed change: a prompt written from the conditions, and the exit fields Settings must hold", () => {
  assert.equal(
    promptOf([
      { path: "migrated", op: "=", value: true },
      { path: "total_fee", op: ">=", value: 3 },
      { path: "flow.5m.buys", op: ">=", value: { path: "flow.5m.sells", times: 1.5 } },
      { path: "age_minutes", op: "<", value: 30 },
    ]),
    "Buy only when all of these hold:\n- migrated is true\n- total_fee is 3 or more\n- flow.5m.buys is at least 1.5 times flow.5m.sells\n- age_minutes is below 30\nSkip everything else.",
  );
  openDb(":memory:");
  const cfg = loadConfig();
  assert.deepEqual(
    exitFields({ ...cfg, exitMode: "agent" }, { sl: -30, tp: [{ at: 15, sell: 100 }], time_min: 20 }).map((f) => [f.label, f.from, f.to]),
    [
      ["Who sets take profit and stop loss", "Agent decides", "Fixed plan"],
      ["Fixed plan", "SL −25% · TP +60% / +150% / +400% selling 40% / 30% / 30%", "SL −30% · one TP +15% selling 100%"],
      ["Time stop", "30 min", "20 min"],
    ],
  );
  // An idea on rank tokens passed, Settings saved after: still no paper test, the agent never sees those tokens.
  insert("hypotheses", { id: 1, created_at: 1, author: "m", rule: "r", conditions: "[]", exit: JSON.stringify({ sl: -30, tp: [{ at: 15, sell: 100 }], time_min: 30 }), source: "rank", need_pct: 95, status: "passed", decided_at: 1 });
  insert("config_history", { at: 2, value: "{}" });
  assert.match(move(1, "paper")!, /does not brief sampled tokens/);
});

test("paper line: passed ideas take the one test in the order they passed, never on another test's version", () => {
  openDb(":memory:");
  const exit = JSON.stringify({ sl: -30, tp: [{ at: 15, sell: 100 }], time_min: 30, drain: 55, slots: 2, size_sol: 0.1 });
  for (const [id, at] of [[1, 20], [2, 10]]) // #2 passed first
    insert("hypotheses", { id, created_at: 1, author: "m", rule: "r", conditions: "[]", exit, need_pct: 95, status: "passed", decided_at: at, result: "{}" });

  assert.match(move(1, "apply")!, /#2 passed first and goes on paper first: drop it to let #1 go ahead/);
  assert.match(move(1, "paper")!, /#2 passed first/);
  assert.equal(move(2, "apply"), null);
  assert.equal(move(2, "paper"), null);
  assert.match(move(1, "paper")!, /#2 is on paper: one test at a time, #1 waits its turn/);
  assert.match(move(1, "apply")!, /#2 is on paper/); // Apply waits too: it would end #2's version
  db.prepare("update hypotheses set status = 'live', result = '{}' where id = 2").run(); // its live stake, no verdict yet
  assert.match(move(1, "paper")!, /#2 is on its live stake/);
  assert.equal(move(2, "drop"), null);
  assert.equal(move(1, "apply"), null); // the same prompt and exits as #2: #2's version
  assert.match(move(1, "paper")!, /the version #2 was tested on/);
  db.prepare("update hypotheses set conditions = ? where id = 1").run(JSON.stringify(idea().conditions)); // a prompt of its own
  assert.match(move(1, "paper")!, /press Apply first/);
  assert.equal(move(1, "apply"), null);
  assert.equal(move(1, "paper"), null);
});

test("daily research: due a day after the last research run starts (before any, a day after the first track), never without a model key", () => {
  openDb(":memory:");
  const key = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "k";
  try {
    const t0 = Date.UTC(2026, 10, 2, 8, 0);
    assert.equal(researchDue(t0), false); // a fresh ledger: no track to read yet
    insert("shadow_tracks", { token: "A", source: "signal", features: "{}", started_at: t0 - RESEARCH_EVERY_MS + 1 });
    assert.equal(researchDue(t0), false); // never ran, the first track not a day old
    assert.equal(researchDue(t0 + 1), true); // never ran, a day of tracks
    insert("agent_runs", { started_at: t0, model: "m", status: "ok", kind: "research" });
    insert("agent_runs", { started_at: t0 + 3_600_000, model: "m", status: "ok" }); // a trading run does not count
    assert.equal(nextResearchAt(), t0 + RESEARCH_EVERY_MS);
    assert.equal(researchDue(t0 + RESEARCH_EVERY_MS - 1), false);
    assert.equal(researchDue(t0 + RESEARCH_EVERY_MS), true);
    delete process.env.OPENROUTER_API_KEY;
    assert.equal(researchDue(t0 + RESEARCH_EVERY_MS), false);
  } finally {
    if (key === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = key;
  }
});

test("register: a repeat of any try is refused, whatever its words; a variant is a new try", () => {
  openDb(":memory:");
  const two = { sl: -30, tp: [{ at: 15, sell: 50 }, { at: 40, sell: 50 }], time_min: 30 };
  assert.equal(reg(idea({ exit: two }), "m").id, 1);
  const count = () => (db.prepare("select count(*) n from hypotheses").get() as { n: number }).n;
  // Other words, conditions reordered and repeated, take profits listed the other way round: the same try.
  const again = idea({
    rule: "Only the good ones.",
    conditions: [{ path: "good", op: "=", value: true }, { path: "good", op: "=", value: true }],
    exit: { ...two, tp: [...two.tp].reverse() },
  });
  assert.equal(register(validate(again) as Idea, "m"), "already tried as #1 (testing): a try is never re-run as new; change a condition or the exit to try a variant");
  assert.equal(count(), 1);
  // Another stop, or another source: a variant, so a new try with a higher bar.
  assert.equal(reg(idea({ exit: { ...two, sl: -25 } }), "m").id, 2);
  assert.equal(reg(idea({ exit: two, source: "signal" }), "m").id, 3);
  assert.notEqual(
    sameIdea([{ path: "price_usd", op: ">=", value: { path: "ath_price_usd", times: 0.7 } }], two, "decision"),
    sameIdea([{ path: "price_usd", op: ">=", value: { path: "ath_price_usd", times: 0.8 } }], two, "decision"),
  );
});

test("research model: its own settings row, then OPENROUTER_MODEL, then the default; never the trading model, never a Settings version", () => {
  openDb(":memory:");
  const env = process.env.OPENROUTER_MODEL;
  try {
    saveConfig({ ...loadConfig(), model: "trading/model" });
    const versions = () => (db.prepare("select count(*) n from config_history").get() as { n: number }).n;
    const before = versions();
    delete process.env.OPENROUTER_MODEL;
    assert.deepEqual(researchSettings(), { model: "" });
    assert.equal(researchModel(), FALLBACK_MODEL);
    process.env.OPENROUTER_MODEL = "env/model";
    assert.equal(researchModel(), "env/model");
    assert.deepEqual(saveResearchSettings({ model: "  research/model  " }), { model: "research/model" });
    assert.equal(researchModel(), "research/model");
    assert.deepEqual(saveResearchSettings({ model: 42 }), { model: "" }); // not a string: cleared, back to the env
    assert.equal(researchModel(), "env/model");
    assert.equal(versions(), before);
    assert.equal(loadConfig().model, "trading/model");
  } finally {
    if (env === undefined) delete process.env.OPENROUTER_MODEL;
    else process.env.OPENROUTER_MODEL = env;
  }
});

test("research agent: the register still works once every read is spent", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "tta-research-")), "t.db");
  const [env, realFetch] = [process.env.TTA_DB, globalThis.fetch];
  process.env.TTA_DB = file; // the agent's read-only connection opens the same file
  openDb(file);
  const call = (i: number, name: string, args: unknown) => ({ id: `c${i}`, function: { name, arguments: JSON.stringify(args) } });
  const replies = [
    { role: "assistant", content: null, tool_calls: [...Array.from({ length: 41 }, (_, i) => call(i, "ledger_query", { sql: "select 1" })), call(41, "register_hypothesis", idea())] },
    { role: "assistant", content: "report" },
  ];
  globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ message: replies.shift() }] }))) as any;
  try {
    const before = tries().length;
    await agent();
    const calls = db.prepare("select result from tool_calls order by id").all() as { result: string }[];
    assert.match(calls[40]!.result, /budget spent/); // the 41st read is refused
    assert.equal(tries().length, before + 1); // the register is not
  } finally {
    globalThis.fetch = realFetch;
    if (env === undefined) delete process.env.TTA_DB;
    else process.env.TTA_DB = env;
  }
});
