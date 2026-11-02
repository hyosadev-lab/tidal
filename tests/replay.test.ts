import { test } from "node:test";
import assert from "node:assert/strict";
import { db, insert, openDb } from "../src/db.ts";
import { calibration, replay, type ExitPlan } from "../src/replay.ts";
import type { Point } from "../src/shadow.ts";
import { research } from "../src/view.ts";

const DEEP = 1e9; // a reserve no size moves
const plan: ExitPlan = { rules: [{ kind: "sl", at: -30, sell: 100 }, { kind: "tp", at: 15, sell: 100 }], timeMin: 30, drainPct: 55 };
const close = (a: number | null, b: number) => assert.ok(a !== null && Math.abs(a - b) < 1e-6, `${a} ≉ ${b}`);
const flat = (n: number, liq: number): Point[] => Array.from({ length: n }, () => [0, liq]);

test("replay: take profit, stop, time stop and a ladder, each sold where the path first reaches it", () => {
  close(replay([[0, DEEP], [10, DEEP], [20, DEEP], [50, DEEP]], 0, plan, 0.1, false), 20);
  close(replay([[0, DEEP], [-10, DEEP], [-40, DEEP], [50, DEEP]], 0, plan, 0.1, false), -40);
  close(replay(flat(1000, DEEP), 0, plan, 0.1, false), 0); // the time stop at 30 min
  const ladder: ExitPlan = { ...plan, rules: [{ kind: "tp", at: 10, sell: 50 }, { kind: "tp", at: 20, sell: 50 }] };
  close(replay([[0, DEEP], [12, DEEP], [25, DEEP]], 0, ladder, 0.1, false), 18.5);
  // Bought at point 2 (+10%): a TP at +15 needs the price at +26.5%.
  close(replay([[0, DEEP], [5, DEEP], [10, DEEP], [20, DEEP], [30, DEEP]], 2, plan, 0.1, false), (130 / 110 - 1) * 100);
});

test("replay: size impact both ways, a drained pool, a rug, and no point to buy at", () => {
  // 1 SOL into a 10 SOL reserve: paid 10% over, then sold for 10/10.9 of the value: −1/6.
  close(replay(flat(1000, 10), 0, plan, 1, false), (1 / 1.2 - 1) * 100);
  // The reserve falls under 45% of the entry's: sold right there, into what is left.
  const value = (0.1 / 1.01) * 0.97; // bought 1% over, now −3%
  close(replay([[0, 10], [-2, 9], [-3, 4]], 0, plan, 0.1, false), ((value * (4 / (4 + value))) / 0.1 - 1) * 100);
  // A rug the plan never reacted to (drain 99%): what is held at the end is worth nothing.
  close(replay([[0, 10], [-1, 0.2]], 0, { ...plan, drainPct: 99 }, 0.1, true), -100);
  assert.equal(replay([[0, 10]], 5, plan, 0.1, false), null); // the path is over before the buy
  assert.equal(replay([null, null, [0, 10]], 0, plan, 0.1, false) !== null, true); // 4s late is still a buy
});

function position(token: string, opened: number, path: Point[], pnlPct: number, reason: string) {
  if (!db.prepare("select 1 from tokens where address = ?").get(token)) insert("tokens", { address: token, first_seen_at: 1 });
  const run = insert("agent_runs", { started_at: opened, model: "m", status: "ok" });
  const d = insert("decisions", { run_id: run, token, action: "buy", conviction: 70 });
  const snap = insert("token_snapshots", { token, taken_at: opened, kind: "entry", price_usd: 1, raw: "{}" });
  const p = insert("positions", {
    token, decision_id: d, entry_snapshot_id: snap, mode: "paper", status: "closed", opened_at: opened, closed_at: opened + 60_000,
    close_reason: reason, entry_price_usd: 1, cost_usd: 10, original_qty: "1", qty: "0",
  });
  for (const [i, r] of plan.rules.entries()) insert("exit_rules", { position_id: p, seq: i, kind: r.kind, at_pct: r.at, sell_pct: r.sell });
  insert("trades", { position_id: p, at: opened + 60_000, side: "sell", qty: "1", price_usd: 1, usd: 10 + pnlPct / 10, pnl_usd: pnlPct / 10, reason });
  insert("shadow_tracks", {
    token, source: "decision", decision_id: d, features: "{}", started_at: opened - 4_000, ended_at: opened + 3_600_000,
    end_reason: "done", path: JSON.stringify(path), ret_30m: path.at(-1)![0],
  });
}

test("calibration: real trades replayed on their own tracks, under the config they opened with", () => {
  openDb(":memory:");
  insert("config_history", { at: 1, value: JSON.stringify({ sizeSol: 0.1, timeStopMinutes: 30, liquidityDrainPct: 55 }) });
  const up: Point[] = [[0, DEEP], [0, DEEP], [0, DEEP], [20, DEEP]]; // bought at point 2, TP at +20
  const down: Point[] = [[0, DEEP], [0, DEEP], [0, DEEP], [-35, DEEP]]; // SL at −35
  position("A", 10_000, up, 18, "tp"); // agrees, replay 2 points kinder
  position("B", 20_000, down, 3, "time"); // a loss on replay, a small win in fact: disagrees
  position("C", 30_000, up, 50, "manual"); // closed by hand: not the plan's result, left out
  const c = calibration();
  assert.deepEqual([c.n, c.agree], [2, 1]);
  close(c.gapPct, (20 - 18 + (-35 - 3)) / 2);
});

test("research: 1 track per token, bought vs all decided, conviction bands, sources and versions", () => {
  openDb(":memory:");
  const now = Date.now();
  insert("config_history", { at: now - 5_000, value: "{}" });
  let n = 0;
  const tracked = (source: string, token: string, r: number, action?: string, conviction?: number) => {
    if (!db.prepare("select 1 from tokens where address = ?").get(token)) insert("tokens", { address: token, first_seen_at: 1 });
    let d: number | null = null;
    if (source === "decision") d = insert("decisions", { run_id: insert("agent_runs", { started_at: now, model: "m", status: "ok" }), token, action: action!, conviction: conviction ?? null });
    insert("shadow_tracks", { token, source, decision_id: d, features: "{}", started_at: now - 60_000 + n++, ended_at: now, end_reason: "done", ret_30m: r });
  };
  tracked("decision", "A", -10, "wait", 85);
  tracked("decision", "A", 50, "buy", 90); // A's second track: not in "all decided", but A's buy
  tracked("decision", "B", 4, "buy", 72);
  tracked("decision", "C", -20, "skip", 30);
  tracked("rank", "D", -4);
  tracked("migration", "E", 2);
  insert("shadow_tracks", { token: "F", source: "rank", features: "{}", started_at: now - 1, ended_at: now, end_reason: "unreadable" });

  const r = research(now, "UTC");
  assert.deepEqual(r.candidates.decided, { avg: (-10 + 4 - 20) / 3, n: 3 });
  assert.deepEqual(r.candidates.bought, { avg: (50 + 4) / 2, n: 2 });
  assert.deepEqual(r.conviction.map((b) => b.n), [1, 1, 0, 1]);
  assert.deepEqual(r.sources.map((s) => [s.source, s.n]), [["decision", 3], ["rank", 1], ["migration", 1]]);
  assert.deepEqual([r.today.done, r.today.unreadable, r.today.readable], [6, 1, 6 / 7]);
  assert.deepEqual(r.today.bySource.map((x) => [x.source, x.started, x.readable]), [["decision", 4, 1], ["rank", 2, 0.5], ["migration", 1, 1]]);
  assert.equal(r.agent.last, null);

  // The research agent's closing message is its report; a model wrote it, the page escapes it.
  const msgs = [{ role: "user", content: "brief" }, { role: "assistant", content: "Looked at fees.\nRegistered nothing." }, { role: "tool", content: "x" }];
  insert("agent_runs", { started_at: now, finished_at: now, model: "m", status: "ok", kind: "research", messages: JSON.stringify(msgs) });
  assert.equal(research(now, "UTC").agent.last!.report, "Looked at fees.\nRegistered nothing.");
  assert.deepEqual(r.versions.map((v) => [v.label, v.current, v.trades]), [["v1", true, 0]]);
});
