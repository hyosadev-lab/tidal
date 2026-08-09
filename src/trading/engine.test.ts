import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "./config.ts";
import { store } from "./store.ts";
import * as broker from "./broker.ts";
import { start, stop } from "./engine.ts";
import { candidate } from "./fixtures.ts";
import type { TradeConfig } from "./types.ts";

// Not hermetic. These drive the shared store singleton and rewrite `data/`, and `start()`
// schedules a real scan against the live GMGN API 1.5s later — expect network and a few
// seconds of runtime. The rules themselves are tested in plan.test.ts, without any of that.

const cfg: TradeConfig = { ...DEFAULT_CONFIG };

// ── paper round trip ──────────────────────────────────────────────────

test("a paper round trip moves cash and books PnL", async () => {
  store.reset();
  const start = store.cash;
  const c = candidate();

  const bought = await broker.buy(store, cfg, c, 100, "thesis", 80, 25);
  assert.ok(!("error" in bought), "buy should succeed");
  if ("error" in bought) return;

  assert.ok(store.cash < start, "cash was committed");
  assert.ok(bought.position.qty > 0);
  assert.ok(bought.position.entryPrice > c.priceUsd, "fill includes slippage");
  store.addPosition(bought.position);

  // double the price, then take the whole position
  bought.position.lastPrice = bought.position.entryPrice * 2;
  const sold = await broker.sell(store, cfg, bought.position, 100, "test exit", c.liquidityUsd);
  assert.ok(!("error" in sold), "sell should succeed");
  if ("error" in sold) return;

  assert.ok((sold.trade.pnlUsd ?? 0) > 0, "a 2x should book a profit");
  assert.ok(store.cash > start, "proceeds returned to cash");
  store.reset();
});

test("paper buys cannot overdraw the ledger", async () => {
  store.reset();
  const res = await broker.buy(store, cfg, candidate(), store.cash + 500, "too big", 80, 25);
  assert.ok("error" in res);
  store.reset();
});

test("partial exits book PnL against only the slice sold", async () => {
  store.reset();
  const bought = await broker.buy(store, cfg, candidate(), 100, "t", 80, 25);
  if ("error" in bought) return assert.fail("buy failed");
  store.addPosition(bought.position);
  bought.position.lastPrice = bought.position.entryPrice * 2;
  const sold = await broker.sell(store, cfg, bought.position, 40, "rung 1", 80_000);
  if ("error" in sold) return assert.fail("sell failed");
  assert.ok(Math.abs(sold.qtySold - bought.position.originalQty * 0.4) < 1, "sold 40% of the original size");
  assert.ok((sold.trade.pnlUsd ?? 0) > 30 && (sold.trade.pnlUsd ?? 0) < 45, "PnL is scoped to the slice");
  store.reset();
});

test("a risk envelope that can never clear the floor is refused at start", async () => {
  const saved = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test";
  store.updateConfig({ chain: "sol", mode: "paper", paperStartEquityUsd: 45, riskPerTradePct: 5 });
  store.reset();
  const bad = await start();
  stop();
  assert.equal(bad.ok, false);
  assert.match(bad.error ?? "", /under the \$3 minimum/);

  store.updateConfig({ riskPerTradePct: 25 });
  store.reset();
  const good = await start();
  stop();
  assert.equal(good.ok, true, "25% of $45 clears the SOL floor");

  store.updateConfig({ ...DEFAULT_CONFIG });
  store.reset();
  if (saved === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = saved;
});
