/**
 * The daily loss halt is enforced where positions open. Scratch database; the refusal comes
 * before any GMGN read, so no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TTA_DB = join(mkdtempSync(join(tmpdir(), "tta-")), "test.db");
const { store } = await import("../../../src/core/data/store.ts");
const { openEntries } = await import("../../../src/core/cycle/entries.ts");

test("openEntries buys nothing while halted — a manual scan cannot slip past the loss limit", async () => {
  store.runState = "halted";
  const entries = [{ address: "0xabc", symbol: "T" }] as Parameters<typeof openEntries>[0];
  assert.equal(await openEntries(entries, [], store.config, 3, 0), 0);
  assert.equal(store.positions.length, 0);
});
