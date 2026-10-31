import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitize } from "../src/config.ts";
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
