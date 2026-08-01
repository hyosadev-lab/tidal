import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, sanitizeConfig, liveReady } from "./trading/config.ts";
import { evaluateExit, healthExit, positionSize, runGates, score, toCandidate } from "./trading/plan.ts";
import { store } from "./trading/store.ts";
import * as broker from "./trading/broker.ts";
import { _internals } from "./trading/engine.ts";
import type { Candidate, Position, TradeConfig } from "./trading/types.ts";

const cfg: TradeConfig = { ...DEFAULT_CONFIG };

function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    address: "So11111111111111111111111111111111111111112",
    symbol: "TEST",
    name: "Test",
    priceUsd: 0.001,
    marketCapUsd: 1_000_000,
    liquidityUsd: 80_000,
    volume1hUsd: 120_000,
    change5mPct: 4,
    change1hPct: 35,
    swaps1h: 500,
    holderCount: 900,
    smartDegenCount: 4,
    renownedCount: 1,
    rugRatio: 0.05,
    top10HolderRate: 0.18,
    devHolding: false,
    isWashTrading: false,
    isHoneypot: false,
    buyTax: 0,
    sellTax: 0,
    ageMinutes: 300,
    launchpad: "Pump.fun",
    source: "test",
    gateFailures: [],
    score: 0,
    ...over,
  };
}

function position(over: Partial<Position> = {}): Position {
  return {
    id: "p1",
    chain: "sol",
    address: candidate().address,
    symbol: "TEST",
    openedAt: Date.now(),
    costUsd: 100,
    qty: 100_000,
    originalQty: 100_000,
    entryPrice: 0.001,
    lastPrice: 0.001,
    peakPrice: 0.001,
    realisedUsd: 0,
    filledRungs: [],
    trailArmed: false,
    thesis: "test",
    conviction: 70,
    stopLossPct: 25,
    entryLiquidityUsd: 80_000,
    ...over,
  };
}

// ── gates ─────────────────────────────────────────────────────────────

test("a clean candidate passes every gate", () => {
  assert.deepEqual(runGates(candidate(), cfg), []);
});

test("honeypots and wash trading are rejected outright", () => {
  assert.ok(runGates(candidate({ isHoneypot: true }), cfg).includes("honeypot"));
  assert.ok(runGates(candidate({ isWashTrading: true }), cfg).includes("wash trading"));
});

test("thin liquidity, concentration and rug risk each block entry", () => {
  assert.ok(runGates(candidate({ liquidityUsd: 5_000 }), cfg).some((f) => f.includes("too thin")));
  assert.ok(runGates(candidate({ top10HolderRate: 0.7 }), cfg).some((f) => f.includes("top10")));
  assert.ok(runGates(candidate({ rugRatio: 0.6 }), cfg).some((f) => f.includes("rug")));
});

test("liquidity that is a rounding error next to market cap is blocked", () => {
  const f = runGates(candidate({ liquidityUsd: 30_000, marketCapUsd: 100_000_000 }), cfg);
  assert.ok(f.some((x) => x.includes("2% of mcap")));
});

test("tokens younger than the age floor are blocked", () => {
  assert.ok(runGates(candidate({ ageMinutes: 3 }), cfg).some((f) => f.includes("old")));
});

// ── scoring ───────────────────────────────────────────────────────────

test("smart money lifts the score", () => {
  assert.ok(score(candidate({ smartDegenCount: 6 })) > score(candidate({ smartDegenCount: 0 })));
});

test("an already-extended move scores below a measured one", () => {
  assert.ok(score(candidate({ change1hPct: 600 })) < score(candidate({ change1hPct: 60 })));
});

test("deeper liquidity scores higher", () => {
  assert.ok(score(candidate({ liquidityUsd: 500_000 })) > score(candidate({ liquidityUsd: 31_000 })));
});

// ── sizing ────────────────────────────────────────────────────────────

test("size respects the risk budget and never spends the last of the cash", () => {
  const full = positionSize(cfg, 1000, 1000, 100);
  assert.ok(full <= 1000 * (cfg.riskPerTradePct / 100) + 0.001);
  assert.ok(positionSize(cfg, 1000, 20, 100) <= 18);
});

test("higher conviction sizes larger", () => {
  assert.ok(positionSize(cfg, 1000, 1000, 100) > positionSize(cfg, 1000, 1000, 0));
});

// ── exits ─────────────────────────────────────────────────────────────

test("stop-loss fires at the configured drawdown and exits in full", () => {
  const e = evaluateExit(position({ lastPrice: 0.00074 }), cfg);
  assert.equal(e?.percent, 100);
  assert.equal(e?.kind, "stop");
});

test("a position inside the envelope produces no exit", () => {
  assert.equal(evaluateExit(position({ lastPrice: 0.0011 }), cfg), null);
});

test("take-profit fills the highest rung a spike reaches", () => {
  const e = evaluateExit(position({ lastPrice: 0.005, peakPrice: 0.005 }), cfg); // +400%
  assert.equal(e?.kind, "tp2");
  assert.equal(e?.percent, 20);
});

test("a filled rung is not sold twice", () => {
  const p = position({ lastPrice: 0.0016, peakPrice: 0.0016, filledRungs: [0] }); // +60%
  assert.equal(evaluateExit(p, cfg), null);
});

test("the trailing stop arms above the threshold and fires on giveback", () => {
  const p = position({ lastPrice: 0.00146, peakPrice: 0.00146, filledRungs: [0] }); // +46%, arms
  assert.equal(evaluateExit(p, cfg), null);
  assert.equal(p.trailArmed, true);
  p.lastPrice = 0.00105; // ~28% off the peak, still green
  const e = evaluateExit(p, cfg);
  assert.equal(e?.kind, "trail");
  assert.equal(e?.percent, 100);
});

test("the time stop closes dead money but spares a winner", () => {
  const old = Date.now() - (cfg.timeStopMinutes + 10) * 60_000;
  assert.equal(evaluateExit(position({ openedAt: old, lastPrice: 0.00101 }), cfg)?.kind, "time");
  assert.equal(evaluateExit(position({ openedAt: old, lastPrice: 0.00109 }), cfg), null);
});

test("drained liquidity forces an exit", () => {
  const e = healthExit(position(), { liquidity: 20_000 }, 80_000);
  assert.equal(e?.percent, 100);
  assert.equal(healthExit(position(), { liquidity: 79_000 }, 80_000), null);
});

// ── config safety ─────────────────────────────────────────────────────

test("out-of-range config is clamped rather than trusted", () => {
  const c = sanitizeConfig({ riskPerTradePct: 900, intervalMinutes: 0, stopLossPct: -5, maxOpenPositions: 999 });
  assert.equal(c.riskPerTradePct, 25);
  assert.equal(c.intervalMinutes, 1);
  assert.equal(c.stopLossPct, 5);
  assert.equal(c.maxOpenPositions, 20);
});

test("an unknown chain falls back instead of reaching the CLI", () => {
  assert.equal(sanitizeConfig({ chain: "; rm -rf /" as never }).chain, DEFAULT_CONFIG.chain);
});

test("live mode stays disarmed without the operator's opt-in", () => {
  const saved = process.env.GMGN_ALLOW_AUTOMATED_TRADES;
  delete process.env.GMGN_ALLOW_AUTOMATED_TRADES;
  assert.equal(liveReady({ ...cfg, walletAddress: "abc" }).ok, false);
  process.env.GMGN_ALLOW_AUTOMATED_TRADES = "1";
  assert.equal(liveReady({ ...cfg, walletAddress: "" }).ok, false, "wallet is still required");
  assert.equal(liveReady({ ...cfg, walletAddress: "abc" }).ok, true);
  if (saved === undefined) delete process.env.GMGN_ALLOW_AUTOMATED_TRADES;
  else process.env.GMGN_ALLOW_AUTOMATED_TRADES = saved;
});

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

// ── model output parsing ──────────────────────────────────────────────

test("a decision is recovered from a fenced, chatty reply", () => {
  const d = _internals.extractJson(
    'Here you go:\n```json\n{"entries":[{"address":"abc","conviction":72,"thesis":"x"}],"exits":[],"notes":"quiet"}\n```\nHope that helps.',
  );
  assert.equal(d?.entries.length, 1);
  assert.equal(d?.notes, "quiet");
});

test("garbage in the model reply yields no decision rather than a bad one", () => {
  assert.equal(_internals.extractJson("no json here at all"), null);
});

test("a rank row maps onto a candidate", () => {
  const c = toCandidate(
    {
      address: "abc",
      symbol: "WIF",
      price: "0.5",
      liquidity: "120000",
      volume: "50000",
      smart_degen_count: 3,
      rug_ratio: 0.04,
      top_10_holder_rate: 0.15,
      creator_token_status: "creator_close",
      price_change_percent1h: 0.42,
      creation_timestamp: Math.floor(Date.now() / 1000) - 3600,
    },
    "trending",
  );
  assert.equal(c.symbol, "WIF");
  assert.equal(c.liquidityUsd, 120_000);
  assert.equal(c.devHolding, false);
  assert.ok(Math.abs(c.change1hPct - 42) < 0.01, "ratio converted to percent");
  assert.ok(c.ageMinutes > 55 && c.ageMinutes < 65);
});
