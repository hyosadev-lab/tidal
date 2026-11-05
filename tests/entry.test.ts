import { test } from "node:test";
import assert from "node:assert/strict";
import { start, status, stop } from "../src/control.ts";
import { openDb } from "../src/db.ts";
import { entryLoop, feedOf, interleave, isPump, wake } from "../src/entry.ts";
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

test("the brief takes the two lists in turns", () => {
  assert.deepEqual(interleave(["t1", "t2", "t3"], ["c1"]), ["t1", "c1", "t2", "t3"]);
  assert.deepEqual(interleave([], ["c1", "c2"]), ["c1", "c2"]);
});

test("signal rows keep Pump.fun launches on pump pools; feed names the list or lists", () => {
  assert.equal(isPump({ launchpad: "pump", exchange: "pump" }), true); // still on the curve
  assert.equal(isPump({ launchpad_platform: "Pump.fun", exchange: "pump" }), true); // a live signal row's fields
  assert.equal(isPump({ launchpad_platform: "pump_mayhem", exchange: "pump_amm" }), true); // migrated to PumpSwap
  assert.equal(isPump({ launchpad_platform: "pump_mayhem_agent", exchange: "raydium" }), false); // pump family, but a pool not read
  assert.equal(isPump({ launchpad_platform: "ray_launchpad", exchange: "ray_launchpad" }), false);
  assert.equal(isPump({ launchpad_platform: "Pump.fun", exchange: "meteora_damm_v2" }), false); // a pool not read on-chain
  const f = { trending: ["a", "b"], signals: ["b", "c"] };
  assert.deepEqual(["a", "b", "c", "w"].map((t) => feedOf(t, f)), ["1h trending", "1h trending + signals", "signals", null]);
});
