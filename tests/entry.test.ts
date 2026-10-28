import { test } from "node:test";
import assert from "node:assert/strict";
import { start, status, stop } from "../src/control.ts";
import { openDb } from "../src/db.ts";
import { entryLoop, wake } from "../src/entry.ts";
import { positionClosed } from "../src/trade.ts";

test("entry loop: idles with no fetch when it cannot buy, runs again on a wake, ends on Stop", async () => {
  openDb(":memory:");
  delete process.env.OPENROUTER_API_KEY; // a cycle that cannot buy, without touching the network
  start();
  const loop = entryLoop();
  await new Promise((r) => setImmediate(r));
  assert.match(status.entry.note, /OPENROUTER_API_KEY/);
  const first = status.entry.lastAt;

  await new Promise((r) => setTimeout(r, 5));
  positionClosed.dispatchEvent(new Event("close")); // a close wakes it: one more cycle, then idle again
  await new Promise((r) => setImmediate(r));
  assert.ok(status.entry.lastAt > first);

  await stop(false);
  wake();
  await loop; // resolves: the loop ends once the run is stopped
});
