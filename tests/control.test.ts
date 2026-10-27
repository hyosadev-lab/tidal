import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitize } from "../src/config.ts";
import { bootStopped, getRun, lossPaused, resume, start, startOfDay } from "../src/control.ts";
import { db, openDb } from "../src/db.ts";

const DAY = 86_400_000;
const today = startOfDay(Date.now()) + 12 * 3_600_000;
const equity = (at: number, e: number) => db.prepare("insert into equity (at, equity_usd, cash_usd) values (?, ?, ?)").run(at, e, e);

test("daily loss: pauses past the limit; auto lifts at midnight, manual waits for Resume", () => {
  for (const mode of ["auto", "manual"] as const) {
    openDb(":memory:");
    const cfg = sanitize({ maxDailyLossPct: 20, lossResume: mode });
    equity(today - DAY - 3_600_000, 1000); // yesterday
    equity(today - DAY, 700); // −30% yesterday
    assert.equal(lossPaused(cfg, today - DAY), true);

    equity(startOfDay(today) + 60_000, 700); // a new day starts at 700, no loss today
    assert.equal(lossPaused(cfg, today), mode === "manual", mode);

    resume();
    assert.equal(lossPaused(cfg, today), false);
    equity(today + 60_000, 500); // −29% today, after the Resume: the rest of today trades
    assert.equal(lossPaused(cfg, today + 120_000), false);
    assert.equal(getRun().pausedAt, null);
  }
});

test("a fresh ledger is stopped, and every boot stops a run that was going", () => {
  openDb(":memory:");
  assert.equal(getRun().state, "stopped");
  start();
  assert.equal(getRun().state, "running");
  bootStopped();
  assert.equal(getRun().state, "stopped");
});
