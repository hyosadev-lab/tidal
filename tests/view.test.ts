import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitize } from "../src/config.ts";
import { db, openDb } from "../src/db.ts";
import { dayStart, overview, zone } from "../src/view.ts";

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
