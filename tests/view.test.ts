import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitize } from "../src/config.ts";
import { status } from "../src/control.ts";
import { db, openDb } from "../src/db.ts";
import { buyingPaused } from "../src/trade.ts";
import { activityBefore, dayStart, fillsBefore, overview, runsBefore, trading, zone } from "../src/view.ts";

test("dayStart: the viewer's midnight, ahead of and behind UTC, across DST", () => {
  assert.equal(dayStart(Date.UTC(2026, 9, 28, 7, 58), "Asia/Jakarta"), Date.UTC(2026, 9, 27, 17)); // 14:58 WIB
  assert.equal(dayStart(Date.UTC(2026, 9, 27, 17), "Asia/Jakarta"), Date.UTC(2026, 9, 27, 17)); // exactly midnight
  assert.equal(dayStart(Date.UTC(2026, 9, 28, 7, 58), "UTC"), Date.UTC(2026, 9, 28));
  assert.equal(dayStart(Date.UTC(2026, 9, 28, 3), "America/Los_Angeles"), Date.UTC(2026, 9, 27, 7)); // 20:00 PDT the day before
  assert.equal(dayStart(Date.UTC(2026, 9, 25, 12), "Europe/Paris"), Date.UTC(2026, 9, 24, 22)); // DST ends that night: +2 at midnight
  assert.equal(dayStart(Date.UTC(2026, 9, 26, 12), "Europe/Paris"), Date.UTC(2026, 9, 25, 23));
  assert.equal(dayStart(Date.UTC(2026, 2, 8, 18), "America/New_York"), Date.UTC(2026, 2, 8, 5)); // DST starts that day
  assert.equal(dayStart(Date.UTC(2026, 2, 9, 18), "America/New_York"), Date.UTC(2026, 2, 9, 4));
  assert.equal(zone("Asia/Jakarta"), "Asia/Jakarta");
  assert.equal(zone("Not/AZone"), Intl.DateTimeFormat().resolvedOptions().timeZone);
});

test("the daily PnL chart buckets sells by the viewer's days", () => {
  openDb(":memory:");
  db.exec("pragma foreign_keys = off");
  const sell = (at: number, pnl: number) =>
    db.prepare("insert into trades (position_id, at, side, qty, price_usd, usd, pnl_usd, reason) values (1, ?, 'sell', '1', 1, 5, ?, 'tp')").run(at, pnl);
  sell(Date.UTC(2026, 9, 27, 16, 59), -3); // 23:59 WIB on the 27th
  sell(Date.UTC(2026, 9, 27, 17, 1), -5); // 00:01 WIB on the 28th, still the 27th in UTC
  const now = Date.UTC(2026, 9, 28, 8);
  const cfg = sanitize({});
  const days = (tz: string) => overview(cfg, "7d", now, tz).chart.pnl.slice(-2).map((d) => [d.pnl, d.sells]);
  assert.deepEqual(days("Asia/Jakarta"), [[-3, 1], [-5, 1]]);
  assert.deepEqual(days("UTC"), [[-8, 2], [0, 0]]);
  assert.equal(overview(cfg, "7d", now, "Asia/Jakarta").today.sells, 1);
});

test("live equity never reads the paper curve", () => {
  openDb(":memory:");
  const now = Date.UTC(2026, 9, 28, 12);
  const row = (at: number, e: number, mode: string) =>
    db.prepare("insert into equity (at, equity_usd, cash_usd, mode) values (?, ?, ?, ?)").run(at, e, e, mode);
  row(now - 3_600_000, 795, "paper");
  const live = sanitize({ mode: "live" });
  assert.equal(overview(live, "7d", now, "UTC").equity, 0); // no live sample yet: not the paper 795
  assert.equal(buyingPaused(live, now), false);
  row(now - 60_000, 20, "live");
  const o = overview(live, "7d", now, "UTC");
  assert.deepEqual([o.equity, o.sinceStart.usd, o.today.usd, o.drawdown.pct], [20, 0, 0, 0]);
  assert.deepEqual(o.chart.equity.map((r) => r.e), [20]);
  assert.equal(buyingPaused(live, now), false); // 795 → 20 is a mode switch, not a −97% day
  assert.equal(overview(sanitize({}), "7d", now, "UTC").chart.equity[0]!.e, 795);
});

test("the Runs list pages through today's runs, All and Failed alike", () => {
  openDb(":memory:");
  const now = Date.UTC(2026, 9, 28, 12);
  const run = (at: number, status: string) =>
    db.prepare("insert into agent_runs (started_at, model, status) values (?, 'm', ?)").run(at, status);
  run(Date.UTC(2026, 9, 27, 12), "error"); // yesterday: in no list
  run(now - 3_600_000, "error");
  for (let i = 0; i < 30; i++) run(now - 3_000_000 + i * 1000, "ok");
  const tr = trading(sanitize({}), now, "UTC");
  assert.equal(tr.runsToday?.failed, 1);
  assert.deepEqual([tr.runs.all.runs.length, tr.runs.all.more], [20, true]);
  assert.deepEqual(tr.runs.failed.runs.map((r) => r.at), [now - 3_600_000]);
  assert.equal(tr.runs.failed.more, false);
  const next = runsBefore(tr.runs.all.runs.at(-1)!.id, tr.runsSince, false);
  assert.deepEqual([next.runs.length, next.more], [11, false]); // the other 10 ok runs and today's failure
  assert.equal(next.runs.at(-1)!.status, "error");
  assert.equal(tr.lastRun, 32);
});

test("Agent activity pages through today's runs only, ten at a time", () => {
  openDb(":memory:");
  const now = Date.UTC(2026, 9, 28, 12);
  const run = (at: number) => db.prepare("insert into agent_runs (started_at, model, status) values (?, 'm', 'ok')").run(at);
  run(Date.UTC(2026, 9, 27, 23, 59)); // yesterday: never shown
  for (let i = 0; i < 15; i++) run(now - 3_000_000 + i * 1000);
  const tr = trading(sanitize({}), now, "UTC");
  const ids = (a: Record<string, any>[]) => [...new Set(a.map((e) => e.runId))];
  assert.deepEqual(ids(tr.activity), [16, 15, 14, 13, 12, 11, 10, 9, 8, 7]);
  assert.equal(tr.activityMore, true);
  const next = activityBefore(7, tr.runsSince);
  assert.deepEqual([ids(next.activity), next.more], [[6, 5, 4, 3, 2], false]);
});

test("the token list: a tab per list, a token on both in both, a wait off both under the list that last carried it", () => {
  openDb(":memory:");
  const now = Date.UTC(2026, 10, 3, 12);
  const row = (address: string, list: "trending" | "signals") => ({
    address, symbol: address, list, mcap: 1, liq: 1, buys: list === "trending" ? 1 : null, sells: list === "trending" ? 1 : null,
    change1h: list === "trending" ? 5 : null, top10: 0.1, bundler: 0.1, rug: 0.1, createdAt: now,
  });
  status.fetch = { at: now, rows: [row("T", "trending"), row("B", "trending"), row("B", "signals"), row("S", "signals")] };
  db.prepare("insert into agent_runs (id, started_at, model, status) values (1, ?, 'm', 'ok')").run(now - 600_000);
  db.prepare("insert into token_signals (id, token, signal_type, trigger_at) values ('e1', 'S', 12, ?), ('e2', 'S', 18, ?)").run(now - 600_000, now - 120_000);
  // waits now due, off both lists: one last briefed off the signal list, one before briefs named their feed
  for (const [token, feed] of [["WS", "signals"], ["WOLD", null]] as const) {
    db.prepare("insert into tokens (address, first_seen_at) values (?, ?)").run(token, now);
    const d = db.prepare("insert into decisions (run_id, token, action, recheck_at) values (1, ?, 'wait', ?)").run(token, now - 1);
    db.prepare("insert into shadow_tracks (token, source, decision_id, features, started_at) values (?, 'decision', ?, ?, ?)")
      .run(token, d.lastInsertRowid, JSON.stringify(feed ? { feed } : {}), now - 600_000);
  }
  const { lists } = trading(sanitize({}), now, "UTC");
  assert.deepEqual(lists.trending.rows.map((r) => r.address), ["T", "B", "WOLD"]);
  assert.deepEqual(lists.signals.rows.map((r) => r.address), ["B", "S", "WS"]);
  assert.deepEqual([lists.trending.fetched, lists.signals.fetched], [2, 2]);
  const s = lists.signals.rows[1]!;
  assert.deepEqual([s.buys, s.signal, s.signalAt], [null, "pump_claim", now - 120_000]); // the latest event on record
  status.fetch = { at: 0, rows: [] };
});

test("Fills pages through every fill, any day, newest first, ties by id", () => {
  openDb(":memory:");
  db.exec("pragma foreign_keys = off");
  db.prepare("insert into tokens (address, first_seen_at, symbol) values ('MintAddress1234', 1, 'AODF')").run();
  db.prepare(
    "insert into positions (id, token, entry_snapshot_id, mode, status, opened_at, entry_price_usd, cost_usd, original_qty, qty) values (1, 'MintAddress1234', 1, 'paper', 'closed', 1, 1, 9, '100', '0')",
  ).run();
  const fill = (at: number) => db.prepare("insert into trades (position_id, at, side, qty, price_usd, usd, reason) values (1, ?, 'buy', '100', 1, 9, 'entry')").run(at);
  for (const at of [1, 2, 2, 3, Date.UTC(2020, 0, 1)]) fill(at); // ids 1..5; ids 2 and 3 share an at
  const ids = (p: ReturnType<typeof fillsBefore>) => p.fills.map((f) => f.id);
  const p1 = fillsBefore(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 2);
  assert.deepEqual([ids(p1), p1.more], [[5, 4], true]);
  assert.deepEqual([p1.fills[0]!.address, p1.fills[0]!.mint, p1.fills[0]!.symbol], ["MintAddress1234", "Mint…1234", "AODF"]);
  const p2 = fillsBefore(p1.fills[1]!.at, p1.fills[1]!.id, 2);
  assert.deepEqual([ids(p2), p2.more], [[3, 2], true]);
  const p3 = fillsBefore(p2.fills[1]!.at, p2.fills[1]!.id, 2);
  assert.deepEqual([ids(p3), p3.more], [[1], false]);
});
