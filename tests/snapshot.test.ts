import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { briefRow, writeSignal, writeSnapshot } from "../src/snapshot.ts";

test("brief signals: counts by name from the highest tally, newest first, none after the snapshot", () => {
  const dir = mkdtempSync(join(tmpdir(), "tta-snap-"));
  const db = openDb(join(dir, "tta.db"));
  try {
    const min = 60_000;
    const id = writeSnapshot({ address: "Mint", price: { price: "1" } }, "decision", 10 * min);
    const sig = (id: string, type: number, atMin: number, mc: number, times: Record<string, number>) =>
      writeSignal("Mint", { id, signal_type: type, trigger_at: (atMin * min) / 1000, trigger_mc: mc, first_trigger_mc: 5000, signal_times: Object.keys(times).length, signal_times_by_type: times });
    sig("a", 12, 1, 5000, { "12": 1 });
    sig("b", 20, 5, 8000, { "12": 1, "20": 1, "10": 1 });
    sig("a", 12, 1, 5000, { "12": 1, "20": 1, "10": 1 }); // seen again: one row, tally refreshed
    sig("c", 6, 20, 9000, { "12": 1, "20": 1, "10": 1, "6": 1 }); // after the snapshot

    assert.deepEqual(briefRow(id).signals, {
      counts: { smart_money_buy: 1, kol_buy: 1, bundler_sell: 1 },
      first_mc_usd: 5000,
      recent: [
        { type: "kol_buy", minutes_ago: 5, mc_usd: 8000 },
        { type: "smart_money_buy", minutes_ago: 9, mc_usd: 5000 },
      ],
    });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
