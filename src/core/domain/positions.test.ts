import { test } from "node:test";
import assert from "node:assert/strict";
import { gasReserve, minPosition, sanitizeConfig } from "./config.ts";
import { position } from "./fixtures.ts";
import { entryStrategy, evaluateExit, healthExit, positionSize } from "./positions.ts";
import type { StrategyRule } from "./types.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import type { TradeConfig } from "./types.ts";

// Sizing, the exit plan, and the rules that run every monitor tick. Pure: no network, no store.

const cfg: TradeConfig = { ...DEFAULT_CONFIG };

// ── sizing ────────────────────────────────────────────────────────────

test("size is the fixed native amount, and never the last of the cash", () => {
  const c = { ...cfg, chain: "sol" as const, positionSizeNative: { sol: 0.1, eth: 0.005 } };
  assert.equal(positionSize(c, 1000, 200), 20, "0.1 × $200 regardless of the balance");
  assert.equal(positionSize(c, 10000, 200), 20);
  assert.equal(positionSize(c, 20, 200), 18, "a thin balance shrinks the buy");
  assert.equal(positionSize({ ...c, chain: "bsc" }, 1000, 200), 0, "a chain with no size set does not trade");
});

test("sizes are kept per chain, and a blank one is not carried over", () => {
  const c = sanitizeConfig({ positionSizeNative: { sol: 0.1, eth: "", bsc: -1, doge: 5 } as never });
  assert.deepEqual(c.positionSizeNative, { sol: 0.1 });
  assert.deepEqual(sanitizeConfig({}, c).positionSizeNative, { sol: 0.1 }, "untouched input keeps what was stored");
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

test("the time stop is a hard cap — it closes a winner too", () => {
  const old = Date.now() - (cfg.timeStopMinutes + 10) * 60_000;
  assert.equal(evaluateExit(position({ openedAt: old, lastPrice: 0.00101 }), cfg)?.kind, "time");
  const winner = evaluateExit(position({ openedAt: old, lastPrice: 0.00109 }), cfg);
  assert.equal(winner?.kind, "time");
  assert.equal(winner?.percent, 100);
  // Still nothing before the cap, at any PnL.
  const young = Date.now() - (cfg.timeStopMinutes - 5) * 60_000;
  assert.equal(evaluateExit(position({ openedAt: young, lastPrice: 0.00101 }), cfg), null);
});

// ── rule-set exits (Fixed trading strategy / the analyst's own plan) ──

const RULES: StrategyRule[] = [
  { kind: "sl", at: -30, sell: 100 },
  { kind: "tp", at: 60, sell: 40 },
  { kind: "tp", at: 400, sell: 20 },
  { kind: "ttp", at: 100, dd: 25, sell: 50 },
];

test("a position with rules ignores the config stop and ladder", () => {
  // -26%: past the config's -25% stop, inside the rule set's -30% one.
  assert.equal(evaluateExit(position({ strategy: RULES, lastPrice: 0.00074 }), cfg), null);
  const e = evaluateExit(position({ strategy: RULES, lastPrice: 0.0006 }), cfg);
  assert.equal(e?.kind, "rule0");
  assert.equal(e?.percent, 100);
});

test("the highest take-profit rule a spike reaches wins", () => {
  const e = evaluateExit(position({ strategy: RULES, lastPrice: 0.005, peakPrice: 0.005 }), cfg);
  assert.equal(e?.kind, "rule2");
  assert.equal(e?.percent, 20);
});

test("a trailing take-profit rule needs both the arm and the giveback", () => {
  // Peak +150% so the ttp is armed, but only 10% off it. The +60% rung is already filled.
  const held = { strategy: RULES, peakPrice: 0.0025, filledRungs: [1] };
  assert.equal(evaluateExit(position({ ...held, lastPrice: 0.00225 }), cfg), null);
  const e = evaluateExit(position({ ...held, lastPrice: 0.0018 }), cfg);
  assert.equal(e?.kind, "rule3");
  assert.equal(e?.percent, 50);
});

test("a trailing stop tighter than the stop loss does not shadow it on the way down", () => {
  // The shape the analyst keeps writing: a -30% stop plus a 15% trail. Live from entry the
  // trail would fire first on any drop and the stop could never be reached.
  const rules: StrategyRule[] = [
    { kind: "sl", at: -30, sell: 100 },
    { kind: "tsl", dd: 15, sell: 100 },
  ];
  // -15%: a full 15% off the peak, but underwater — the stop owns this half of the range.
  assert.equal(evaluateExit(position({ strategy: rules, lastPrice: 0.00085 }), cfg), null);
  assert.equal(evaluateExit(position({ strategy: rules, lastPrice: 0.00069 }), cfg)?.kind, "rule0");
  // +100% then 15% back off the peak: in profit, so the trail is the one that fires.
  const won = position({ strategy: rules, peakPrice: 0.002, lastPrice: 0.0017 });
  assert.equal(evaluateExit(won, cfg)?.kind, "rule1");
});

test("the stop loss wins a tick a trailing rule listed above it also triggers on", () => {
  // Memecoins gap between two 30s polls, so one tick can satisfy both rules. Order in the
  // list must not decide it: a `ttp` first would sell its own 50% down here and leave the
  // other half to the stop a tick later, which is how a stop stops mattering.
  const rules: StrategyRule[] = [
    { kind: "ttp", at: 20, dd: 60, sell: 50 },
    { kind: "sl", at: -30, sell: 100 },
  ];
  // Peaked at +30% (arming the ttp), now -50%: past the stop, and 62% off the peak.
  const gapped = position({ strategy: rules, peakPrice: 0.0013, lastPrice: 0.0005 });
  const e = evaluateExit(gapped, cfg);
  assert.equal(e?.kind, "rule1", "the stop, not the ttp written above it");
  assert.equal(e?.percent, 100);
});

test("a trailing take-profit does not fire underwater either", () => {
  // Same guard the tsl has: armed at +140%, 60% off the peak, but the position is at -5%.
  // Above the stop, so the answer is to wait for the stop — not to book a loss as a "profit".
  const rules: StrategyRule[] = [
    { kind: "ttp", at: 20, dd: 60, sell: 50 },
    { kind: "sl", at: -30, sell: 100 },
  ];
  assert.equal(evaluateExit(position({ strategy: rules, peakPrice: 0.0024, lastPrice: 0.00095 }), cfg), null);
  // Still in profit at +8% after the same giveback: now it is genuinely profit protection.
  const inProfit = position({ strategy: rules, peakPrice: 0.0027, lastPrice: 0.00108 });
  assert.equal(evaluateExit(inProfit, cfg)?.kind, "rule0");
});

test("a filled rule is not sold twice", () => {
  const p = position({ strategy: RULES, lastPrice: 0.0016, peakPrice: 0.0016, filledRungs: [1] });
  assert.equal(evaluateExit(p, cfg), null);
});

test("the time stop still applies to a rule set", () => {
  const old = Date.now() - (cfg.timeStopMinutes + 10) * 60_000;
  assert.equal(evaluateExit(position({ strategy: RULES, openedAt: old, lastPrice: 0.00101 }), cfg)?.kind, "time");
});

test("the model may shape the exit plan but not outrun the stop", () => {
  const dyn = { ...cfg, fixedStrategy: false, stopLossPct: 25 };
  const out = entryStrategy(dyn, [
    { kind: "sl", at: -80, sell: 100 },
    { kind: "tp", at: 90, sell: 60 },
  ]);
  assert.deepEqual(out[0], { kind: "sl", at: -25, sell: 100 });
  assert.equal(out.length, 2);
});

test("a plan with no stop gets one, and an unusable plan falls back to the config", () => {
  const dyn = { ...cfg, fixedStrategy: false };
  const added = entryStrategy(dyn, [{ kind: "tp", at: 90, sell: 100 }]);
  assert.equal(added.length, 2);
  assert.deepEqual(added[1], { kind: "sl", at: -cfg.stopLossPct, sell: 100 });
  // Nothing salvageable → no rules → evaluateExit uses the config stop/ladder/trail.
  assert.deepEqual(entryStrategy(dyn, [{ kind: "please sell", at: 5 }]), []);
  assert.deepEqual(entryStrategy(dyn, "sell everything"), []);
});

test("fixed mode ignores whatever the model proposes", () => {
  const fixed = { ...cfg, fixedStrategy: true, strategy: [{ kind: "tp" as const, at: 50, sell: 100 }] };
  const out = entryStrategy(fixed, [{ kind: "tp", at: 999, sell: 1 }]);
  assert.deepEqual(out, [
    { kind: "tp", at: 50, sell: 100 },
    { kind: "sl", at: -cfg.stopLossPct, sell: 100 },
  ]);
});

test("drained liquidity forces an exit", () => {
  const e = healthExit(position(), { liquidity: 20_000 }, 80_000);
  assert.equal(e?.percent, 100);
  assert.equal(healthExit(position(), { liquidity: 79_000 }, 80_000), null);
});

// ── minimum position size ─────────────────────────────────────────────

test("the position floor tracks the chain's round-trip cost", () => {
  assert.equal(minPosition({ ...cfg, chain: "sol" }), 3);
  assert.equal(minPosition({ ...cfg, chain: "eth" }), 25);
});

test("gas is held back so a fully deployed wallet can still pay to exit", () => {
  assert.ok(gasReserve({ ...cfg, chain: "sol", gasReserveNative: 0 }) > 0);
  assert.equal(gasReserve({ ...cfg, chain: "sol", gasReserveNative: 0.05 }), 0.05);
});
