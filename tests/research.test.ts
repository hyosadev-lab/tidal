import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { loadConfig, saveConfig } from "../src/config.ts";
import { db, insert, openDb } from "../src/db.ts";
import { adverseGap, beats, drawsFor, exitFields, judge, matches, move, promptOf, register, researchDue, RESEARCH_EVERY_MS, seedTries, tries, validate, type Idea } from "../src/research.ts";
import { query } from "../src/research-cli.ts";
import type { Point } from "../src/shadow.ts";

const DEEP = 1e9;
const idea = (over: Record<string, unknown> = {}) => ({
  rule: "Good tokens only.",
  conditions: [{ path: "good", op: "=", value: true }],
  exit: { sl: -30, tp: [{ at: 15, sell: 100 }], time_min: 30 },
  ...over,
});

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

test("seeds: rounds 1–3 and the ATH check are failed tries 1–4, once; the next try's bar is higher", () => {
  openDb(":memory:");
  seedTries();
  seedTries();
  const t = tries();
  assert.deepEqual(t.map((x) => [x.id, x.status]), [[4, "failed"], [3, "failed"], [2, "failed"], [1, "failed"]]);
  assert.equal(t.find((x) => x.id === 3)!.parent_id, 2);
  assert.ok(t.every((x) => x.author === "seed"));
  const r = register(validate(idea()) as Idea, "claude-code");
  assert.deepEqual([r.id, r.need_pct], [5, 99]);
});

let seq = 0;
/** A decided token's track, and when `cost` is given, the real trade bought on it. */
function decided(at: number, features: object, path: Point[], real?: { pnl: number; reason: string; mode?: string }) {
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
  const good = register(validate(idea()) as Idea, "m", t0);
  const bad = register(validate(idea({ rule: "Bad tokens.", conditions: [{ path: "good", op: "=", value: false }] })) as Idea, "m", t0);
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

test("paper, then live: each step the operator's, each judged at 30 trades on its own fills", () => {
  openDb(":memory:");
  const t0 = Date.UTC(2026, 10, 2, 0, 0);
  const cfg = loadConfig(); // the first config save: the history starts before the idea
  trusted(t0 - 3 * 86_400_000);
  const h = register(validate(idea()) as Idea, "m", t0).id;
  for (let i = 0; i < 40; i++) decided(t0 + 60_000 + i * 600_000, { good: i % 4 !== 3 }, i % 4 !== 3 ? UP : DOWN);
  judge(t0 + 86_400_000);
  assert.equal(tries()[0]!.status, "passed");

  assert.match(move(h, "paper", t0 + 86_400_000)!, /save the rule/);
  db.prepare("delete from config_history").run();
  insert("config_history", { at: t0 + 86_400_000 + 1, value: JSON.stringify(cfg) }); // saved, but with the old exit
  assert.match(move(h, "paper")!, /set the exit fields in Settings first: fixed plan/);
  const fit = { ...cfg, plan: [{ kind: "sl" as const, at: -30, sell: 100 }, { kind: "tp" as const, at: 15, sell: 100 }] };
  saveConfig(fit); // the operator sets the idea's exit and saves
  db.prepare("delete from config_history").run();
  insert("config_history", { at: t0 + 86_400_000 + 2, value: JSON.stringify(fit) }); // on the test's clock
  assert.equal(move(h, "live"), "only an idea that held on paper goes live");
  assert.equal(move(h, "paper"), null);
  const paperAt = t0 + 86_400_000 + 2;
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
  saveConfig({ ...fit, mode: "live" }); // the operator switches to live, at a small size
  const liveAt = paperAt + 3 * 86_400_000 + 1;
  insert("config_history", { at: liveAt, value: JSON.stringify({ ...fit, mode: "live" }) }); // on the test's clock
  assert.equal(move(h, "live"), null);
  for (let i = 0; i < 30; i++) decided(liveAt + 60_000 + i * 1_800_000, { good: true }, DOWN, { pnl: -4, reason: "sl", mode: "live" });
  judge(liveAt + 3 * 86_400_000);
  const r = tries()[0]!;
  assert.deepEqual([r.status, r.result.live.verdict, r.result.dropped_by], ["dropped", "fades", "code"]);
  assert.equal(move(h, "undrop"), "only a drop made by hand can be undone");
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
  assert.match(move(1, "paper")!, /does not brief rank or migration tokens/);
});

test("paper line: passed ideas take the one test in the order they passed, never on another test's version", () => {
  openDb(":memory:");
  const exit = JSON.stringify({ sl: -30, tp: [{ at: 15, sell: 100 }], time_min: 30, drain: 55, slots: 2, size_sol: 0.1 });
  for (const [id, at] of [[1, 20], [2, 10]]) // #2 passed first
    insert("hypotheses", { id, created_at: 1, author: "m", rule: "r", conditions: "[]", exit, need_pct: 95, status: "passed", decided_at: at, result: "{}" });
  saveConfig({ ...loadConfig(), plan: [{ kind: "sl", at: -30, sell: 100 }, { kind: "tp", at: 15, sell: 100 }] }); // saved after both passed
  const save = (db.prepare("select max(at) at from config_history").get() as { at: number }).at;

  assert.match(move(1, "paper")!, /#2 passed first and goes on paper first: drop it to let #1 go ahead/);
  assert.equal(move(2, "paper"), null);
  assert.match(move(1, "paper")!, /#2 is on paper: one test at a time, #1 waits its turn/);
  db.prepare("update hypotheses set status = 'live', result = '{}' where id = 2").run(); // its live stake, no verdict yet
  assert.match(move(1, "paper")!, /#2 is on its live stake/);
  assert.equal(move(2, "drop"), null);
  assert.match(move(1, "paper")!, /the version #2 was tested on/); // its prompt, not #1's
  insert("config_history", { at: save + 1, value: JSON.stringify(loadConfig()) }); // the operator saves #1's prompt
  assert.equal(move(1, "paper"), null);
});

test("daily research: due a day after the last research run starts, button runs included, never without a model key", () => {
  openDb(":memory:");
  const key = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "k";
  try {
    const t0 = Date.UTC(2026, 10, 2, 8, 0);
    assert.equal(researchDue(t0), true); // never ran
    insert("agent_runs", { started_at: t0, model: "m", status: "ok", kind: "research" });
    insert("agent_runs", { started_at: t0 + 3_600_000, model: "m", status: "ok" }); // a trading run does not count
    assert.equal(researchDue(t0 + RESEARCH_EVERY_MS - 1), false);
    assert.equal(researchDue(t0 + RESEARCH_EVERY_MS), true);
    delete process.env.OPENROUTER_API_KEY;
    assert.equal(researchDue(t0 + RESEARCH_EVERY_MS), false);
  } finally {
    if (key === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = key;
  }
});
