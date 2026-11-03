import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitize } from "../src/config.ts";
import { status } from "../src/control.ts";
import { db, openDb } from "../src/db.ts";
import { buyingPaused } from "../src/trade.ts";
import { activityBefore, dayStart, overview, runsBefore, trading, zone } from "../src/view.ts";

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
  const row = (address: string, list: "trending" | "graduated") => ({
    address, symbol: address, list, mcap: 1, liq: 1, buys: 1, sells: 1, change1h: list === "trending" ? 5 : null,
    top10: 0.1, bundler: 0.1, rug: 0.1, createdAt: now, migratedAt: list === "graduated" ? now - 60_000 : null,
  });
  status.fetch = { at: now, rows: [row("T", "trending"), row("B", "trending"), row("B", "graduated"), row("G", "graduated")] };
  db.prepare("insert into agent_runs (id, started_at, model, status) values (1, ?, 'm', 'ok')").run(now - 600_000);
  // waits now due, off both lists: one last briefed as graduated, one before briefs named their feed
  for (const [token, feed] of [["WG", "graduated"], ["WOLD", null]] as const) {
    db.prepare("insert into tokens (address, first_seen_at) values (?, ?)").run(token, now);
    const d = db.prepare("insert into decisions (run_id, token, action, recheck_at) values (1, ?, 'wait', ?)").run(token, now - 1);
    db.prepare("insert into shadow_tracks (token, source, decision_id, features, started_at) values (?, 'decision', ?, ?, ?)")
      .run(token, d.lastInsertRowid, JSON.stringify(feed ? { feed } : {}), now - 600_000);
  }
  const { lists } = trading(sanitize({}), now, "UTC");
  assert.deepEqual(lists.trending.rows.map((r) => r.address), ["T", "B", "WOLD"]);
  assert.deepEqual(lists.graduated.rows.map((r) => r.address), ["B", "G", "WG"]);
  assert.deepEqual([lists.trending.fetched, lists.graduated.fetched], [2, 2]);
  const g = lists.graduated.rows[0]!;
  assert.deepEqual([g.change1h, g.migratedAt], [null, now - 60_000]); // graduated: 24h numbers and a migration time
  status.fetch = { at: 0, rows: [] };
});
