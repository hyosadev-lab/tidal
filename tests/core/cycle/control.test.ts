/**
 * A loss halt resumes itself at the UTC day rollover. Scratch database, mocked clock — no
 * network, no `data/`.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TTA_DB = join(mkdtempSync(join(tmpdir(), "tta-")), "test.db");
const { arm, halt, onResume, disarm } = await import("../../../src/core/cycle/control.ts");

test("halt stops the scan but keeps the monitor watching open positions", () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: Date.UTC(2026, 8, 13, 12, 0, 0) });
  let monitored = 0;
  let scanned = 0;
  arm(30, 60, null, () => monitored++, () => scanned++);

  halt("test halt");
  mock.timers.tick(10 * 60_000);
  assert.equal(scanned, 0);
  assert.equal(monitored, 20);

  disarm();
  mock.timers.reset();
});

test("halt resumes one second after UTC midnight, and disarm cancels it", () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: Date.UTC(2026, 8, 13, 22, 0, 0) });
  let resumed = 0;
  onResume(() => resumed++);

  halt("test halt");
  mock.timers.tick(2 * 3600_000); // exactly 00:00:00 UTC
  assert.equal(resumed, 0);
  mock.timers.tick(1000);
  assert.equal(resumed, 1);

  halt("again");
  disarm(); // what Start and Stop both go through
  mock.timers.tick(86_400_000 + 1000);
  assert.equal(resumed, 1);

  mock.timers.reset();
});
