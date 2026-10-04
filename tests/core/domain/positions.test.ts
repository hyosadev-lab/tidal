import { test } from "node:test";
import assert from "node:assert/strict";
import { gasReserve, minPosition, sanitizeConfig } from "../../../src/core/domain/config.ts";
import { position } from "./fixtures.ts";
import { entryStop, entryStrategy, evaluateExit, healthExit, positionSize } from "../../../src/core/domain/positions.ts";
import type { StrategyRule } from "../../../src/core/domain/types.ts";
import { DEFAULT_CONFIG } from "../../../src/core/domain/config.ts";
import type { TradeConfig } from "../../../src/core/domain/types.ts";

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

test("a staged stop sells in stages, and a gap through all of them fires the deepest", () => {
  const rules: StrategyRule[] = [
    { kind: "sl", at: -10, sell: 50 },
    { kind: "tp", at: 60, sell: 100 },
    { kind: "sl", at: -25, sell: 100 },
  ];
  // -12%: only the first stage is reached, and it sells its own half.
  const first = evaluateExit(position({ strategy: rules, lastPrice: 0.00088 }), cfg);
  assert.equal(first?.kind, "rule0");
  assert.equal(first?.percent, 50);
  // Spent, and still above the second stage: nothing more to do.
  assert.equal(evaluateExit(position({ strategy: rules, lastPrice: 0.00088, filledRungs: [0] }), cfg), null);
  // Memecoins gap between two 30s polls. Straight to -40% takes the last stage, the one sized
  // to close the position — not the first stage's half with the rest left for a tick later.
  const gapped = evaluateExit(position({ strategy: rules, lastPrice: 0.0006 }), cfg);
  assert.equal(gapped?.kind, "rule2");
  assert.equal(gapped?.percent, 100);
});

test("a rule kind the engine no longer runs never fires", () => {
  // Positions opened before trailing rules were removed still carry them in the ledger.
  const stale = [{ kind: "tsl", dd: 10, sell: 100 }, { kind: "sl", at: -30, sell: 100 }] as unknown as StrategyRule[];
  assert.equal(evaluateExit(position({ strategy: stale, peakPrice: 0.002, lastPrice: 0.0015 }), cfg), null);
  assert.equal(evaluateExit(position({ strategy: stale, lastPrice: 0.0006 }), cfg)?.kind, "rule1");
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

test("the model's per-entry stop may tighten the operator's, never deepen it", () => {
  assert.equal(entryStop({ ...cfg, stopLossPct: 25 }, 60), 25);
  assert.equal(entryStop({ ...cfg, stopLossPct: 25 }, 15), 15);
  assert.equal(entryStop({ ...cfg, stopLossPct: 25 }, "nonsense"), 25);
  // An operator stop tighter than the model's floor still binds.
  assert.equal(entryStop({ ...cfg, stopLossPct: 5 }, 10), 5);
});

test("stops that do not cover the position get one more, and an unusable plan falls back to the config", () => {
  const dyn = { ...cfg, fixedStrategy: false };
  const added = entryStrategy(dyn, [{ kind: "tp", at: 90, sell: 100 }]);
  assert.equal(added.length, 2);
  assert.deepEqual(added[1], { kind: "sl", at: -cfg.stopLossPct, sell: 100 });
  // A staged stop that only ever sells 40% leaves the other 60% with no floor.
  const partial = entryStrategy(dyn, [{ kind: "sl", at: -10, sell: 40 }]);
  assert.deepEqual(partial.at(-1), { kind: "sl", at: -cfg.stopLossPct, sell: 100 });
  // Two stages adding up to the whole position are left exactly as written.
  assert.equal(entryStrategy(dyn, [{ kind: "sl", at: -10, sell: 50 }, { kind: "sl", at: -20, sell: 50 }]).length, 2);
  // Trailing kinds are gone: a proposal made only of them is no plan at all.
  assert.deepEqual(entryStrategy(dyn, [{ kind: "ttp", at: 50, dd: 20, sell: 100 }, { kind: "tsl", dd: 15, sell: 100 }]), []);
  // Nothing salvageable → no rules → evaluateExit uses the config stop and ladder.
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
  const e = healthExit(position({ entryLiquidityUsd: 80_000 }), { liquidity: 20_000 });
  assert.equal(e?.percent, 100);
  assert.equal(healthExit(position({ entryLiquidityUsd: 80_000 }), { liquidity: 79_000 }), null);
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
