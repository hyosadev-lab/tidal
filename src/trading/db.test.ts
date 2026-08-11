/**
 * The SQLite store, against a scratch database — `TTA_DB` must be set before anything
 * imports `db.ts`, hence the dynamic imports. Pure otherwise: no network, no `data/`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Trade } from "./types.ts";

process.env.TTA_DB = join(mkdtempSync(join(tmpdir(), "tta-")), "test.db");
const { Store } = await import("./store.ts");

const sell = (id: string, pnl: number): Trade => ({
  id,
  chain: "sol",
  address: "0xabc",
  symbol: "T",
  side: "sell",
  mode: "paper",
  at: Date.now(),
  price: 1,
  qty: 1,
  usd: 1,
  pnlUsd: pnl,
  reason: "test",
});

test("trades, stats and config survive a reopen", () => {
  const a = new Store();
  a.updateConfig({ riskPerTradePct: 7 });
  a.cash = 500;
  a.addTrade(sell("t1", 10));
  a.addTrade(sell("t2", -4));
  a.save();

  const s = a.stats();
  assert.equal(s.wins, 1);
  assert.equal(s.losses, 1);
  assert.equal(Math.round(s.realisedUsd), 6);
  assert.equal(s.winRatePct, 50);
  assert.equal(a.tradeCount(), 2);

  // the debounced save has not fired yet — force it before reopening
  a.saveNow();
  const b = new Store();
  assert.equal(b.config.riskPerTradePct, 7);
  assert.equal(b.cash, 500);
  assert.equal(b.trades()[0]?.id, "t2"); // newest first
  assert.equal(b.stats().wins, 1);
});

test("reset clears the ledger but not the config", () => {
  const s = new Store();
  s.addTrade(sell("t3", 1));
  s.markEquity();
  s.reset();
  assert.equal(s.tradeCount(), 0);
  assert.equal(s.equitySeries().length, 0);
  assert.equal(s.config.riskPerTradePct, 7);
});
