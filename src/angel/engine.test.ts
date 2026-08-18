import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "./core/config.ts";
import { store } from "./state/store.ts";
import * as broker from "./exec/broker.ts";
import { start, stop, _internals } from "./engine.ts";
import { candidate } from "./core/fixtures.ts";
import type { TradeConfig } from "./core/types.ts";

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

// One source of truth for held / cooldown / blacklist: the eligible filter, the dashboard's
// note and the pre-entry re-check all read it, so a drift here silently changes all three.
test("unavailable() names why a gate-passing row still cannot be bought", async () => {
  store.reset();
  const { unavailable } = _internals;
  const c = candidate({ address: "0xAbC" });

  assert.equal(unavailable(c), "", "a clean row is buyable");

  store.blacklist("0xabc");
  assert.equal(unavailable(c), "blacklisted", "matched case-insensitively");

  store.cooldown("0xabc", 60);
  assert.match(unavailable(c), /cooldown/, "cooldown outranks the blacklist");

  const bought = await broker.buy(store, cfg, c, 100, "t", 80, 25);
  if ("error" in bought) return assert.fail("buy failed");
  store.addPosition(bought.position);
  assert.equal(unavailable(c), "already held", "holding it outranks both");

  store.reset();
});

test("stopping before the first scan fires cancels it", async () => {
  const saved = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test";
  store.updateConfig({ ...DEFAULT_CONFIG, mode: "paper" });
  store.reset();

  const r = await start();
  assert.equal(r.ok, true);
  stop();
  await new Promise((done) => setTimeout(done, 2500));
  assert.equal(store.cycleCount, 0, "the 1.5s kick-off scan must not survive a stop");

  store.reset();
  if (saved === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = saved;
});

// ── feed merge ────────────────────────────────────────────────────────

test("a signal alert tags a ranked row but cannot become one on its own", () => {
  const row = (address: string, extra: Record<string, unknown> = {}) => ({
    address,
    symbol: address,
    price: 0.001,
    liquidity: 50_000,
    volume: 10_000,
    swaps: 200,
    buys: 120,
    sells: 80,
    ...extra,
  });

  const merged = _internals.mergeFeeds([
    [[row("RANKED")], "trending-1h"],
    [[row("RANKED", { volume: 3_000, buys: 40, sells: 20 })], "trending-5m"],
    // The signal route returns one row per alert, newest first, so the same token arrives
    // repeatedly — and only the first alert's trigger cap is kept.
    [[row("RANKED", { trigger_mc: 90_000 }), row("RANKED", { trigger_mc: 40_000 }), row("ALERTONLY")], "smart-money"],
    [[row("RANKED", { trigger_mc: 70_000 }), row("SPIKEONLY")], "price-spike"],
  ]);

  assert.deepEqual(
    merged.map((c) => c.address),
    ["RANKED"],
    "a token only a signal feed carried never enters the sweep",
  );
  assert.equal(
    merged[0]?.source,
    "trending-1h+trending-5m+smart-money+price-spike",
    "repeated alerts add each label once",
  );
  assert.equal(merged[0]?.volume1hUsd, 10_000, "the hourly numbers stay the rank feed's");
  assert.equal(merged[0]?.volume5mUsd, 3_000, "the 5m window is carried alongside");
  assert.equal(merged[0]?.triggerMcUsd, 90_000, "the first alert's trigger cap survives the row it came on");
});
