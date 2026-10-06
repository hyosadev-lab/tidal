import { test } from "node:test";
import assert from "node:assert/strict";
import { breakevenPct, minLegUsd, netOfFees } from "../../../src/core/domain/chains.ts";
import { DEFAULT_CONFIG, slippage } from "../../../src/core/domain/config.ts";
import { position } from "../domain/fixtures.ts";
import { evaluateExit, isDust, viableStrategy } from "../../../src/core/domain/positions.ts";
import { conditionOrders, pricedPlan, recordExternalSell, settle } from "../../../src/core/market/broker.ts";
import type { StrategyRule } from "../../../src/core/domain/types.ts";

// Order translation and the sell paths. `settle` and `recordExternalSell` are pure enough
// to pin here; anything that submits lives in cycle.test.ts.

test("an exit booked from the wallet prices the slice at the last seen price", () => {
  const p = position({ qty: 100_000, originalQty: 100_000, costUsd: 100, lastPrice: 0.0008 });
  const r = recordExternalSell(DEFAULT_CONFIG, p, 40_000, "gmgn stop");
  assert.ok(!("error" in r));
  if ("error" in r) return;
  assert.equal(r.proceeds, 32, "40k at $0.0008");
  assert.equal(r.trade.side, "sell");
  assert.equal(r.trade.pnlUsd, -8, "cost basis of the slice is $40");
  assert.equal(r.trade.pnlPct, -20);
});

// Every sell path builds its trade through the same `sellTrade`, so pinning one pins all three.
// The two percentages on a sell are deliberately on different bases and the pairing below is the
// whole reason the field exists: booked -20% net, but the price had been +50% gross at some point,
// which is what says the plan missed an exit rather than the token never offering one.
test("a sell records how far the position ever got, gross, beside what it booked net", () => {
  const p = position({ qty: 100_000, originalQty: 100_000, costUsd: 100, entryPrice: 0.001, lastPrice: 0.0008, peakPrice: 0.0015 });
  const r = recordExternalSell(DEFAULT_CONFIG, p, 40_000, "gmgn stop");
  assert.ok(!("error" in r));
  if ("error" in r) return;
  assert.equal(r.trade.peakPct, 50, "peak 0.0015 against an entry of 0.001");
  assert.equal(r.trade.pnlPct, -20, "and the booked figure is still net, still negative");

  // A position that never traded above its entry reports 0, not a missing field.
  const flat = position({ qty: 100_000, originalQty: 100_000, costUsd: 100, entryPrice: 0.001, lastPrice: 0.0008, peakPrice: 0.001 });
  const f = recordExternalSell(DEFAULT_CONFIG, flat, 40_000, "gmgn stop");
  assert.equal("error" in f ? null : f.trade.peakPct, 0);
});

test("the whole exit plan travels to GMGN, every rung and every stage of the stop", () => {
  const rules: StrategyRule[] = [
    { kind: "tp", at: 35, sell: 40 },
    { kind: "tp", at: 90, sell: 60 },
    { kind: "sl", at: -10, sell: 50 },
    { kind: "sl", at: -18, sell: 100 },
  ];
  const orders = conditionOrders(DEFAULT_CONFIG, rules, 25);
  assert.deepEqual(orders, [
    { order_type: "profit_stop", side: "sell", price_scale: "35", sell_ratio: "40" },
    { order_type: "profit_stop", side: "sell", price_scale: "90", sell_ratio: "60" },
    { order_type: "loss_stop", side: "sell", price_scale: "10", sell_ratio: "50" },
    { order_type: "loss_stop", side: "sell", price_scale: "18", sell_ratio: "100" },
  ]);
});

test("a plan without a stop gets one, and no rules falls back to the config ladder", () => {
  const noStop = conditionOrders(DEFAULT_CONFIG, [{ kind: "tp", at: 40, sell: 100 }], 25);
  assert.equal(noStop.at(-1)?.order_type, "loss_stop", "the floor is appended when the plan omits it");
  assert.equal(noStop.at(-1)?.price_scale, "25");

  const legacy = conditionOrders(DEFAULT_CONFIG, [], 25);
  assert.equal(legacy.filter((o) => o.order_type === "profit_stop").length, DEFAULT_CONFIG.takeProfit.length);
  assert.equal(legacy.filter((o) => o.order_type === "loss_stop").length, 1);
});

// Both live legs book their fill through this. Reading a failed swap as a fill is the worst
// bug in the file: the position would exist in the ledger and nowhere else.
test("a settled swap yields its report, a failed one an error", async () => {
  // No order_id, so nothing is polled — waitForOrder is only reached for an order that landed.
  const ok = await settle("sol", { status: "confirmed", hash: "0xabc", report: { price_usd: 1 } }, "swap");
  assert.deepEqual(ok, { report: { price_usd: 1 }, hash: "0xabc" });

  for (const status of ["failed", "expired", "FAILED"]) {
    const bad = await settle("sol", { status, error_status: "slippage" }, "sell");
    assert.equal("error" in bad ? bad.error : null, `sell ${status.toLowerCase()}: slippage`);
  }

  const noReason = await settle("sol", { status: "failed" }, "swap");
  assert.match("error" in noReason ? noReason.error : "", /unknown$/);

  const bare = await settle("sol", {}, "swap");
  assert.deepEqual(bare, { report: {}, hash: undefined }, "no status is not a failure");
});

test("a paper leg pays a percentage and a flat chain fee, so small legs cost more", () => {
  const SOL = 75; // $/SOL, roughly what the quote route reported when these numbers were measured.
  // $200 crossing one leg: 2.2% routing + pool, plus 0.006 SOL of chain fees.
  assert.equal(netOfFees("sol", 200, SOL).toFixed(2), (200 * 0.978 - 0.45).toFixed(2));

  const cost = (gross: number) => (1 - netOfFees("sol", gross, SOL) / gross) * 100;
  assert.ok(cost(200) < 2.5, "the flat fee disappears into a big leg");
  assert.ok(cost(5) > 10, "and eats a small one — this is the whole reason a $5 rung loses money");
  assert.equal(netOfFees("sol", 0.3, SOL), 0, "a leg worth less than its own fee nets nothing");
});

test("break-even is the round trip, and the flat fee makes it worse the smaller the position", () => {
  const SOL = 75;
  const big = breakevenPct("sol", 500, SOL);
  const small = breakevenPct("sol", 20, SOL);
  assert.ok(big > 4 && big < 6, `a $500 position clears on the percentage half alone, got ${big}`);
  assert.ok(small > 8, `a $20 one has to carry $0.90 of chain fees too, got ${small}`);
  // Measured against the live quote in the same units: $20 in, $20.65 out of the wallet.
  assert.ok(Math.abs(breakevenPct("sol", 20, SOL, 20.65) - 7.9) < 0.5);
});

// Noise floor held at 0 throughout: this test is about the fee half, and mixing the two would
// stop it failing for the reason it is named after. The noise half is the test below it.
test("the exit plan is repriced to what the fees allow", () => {
  const minLeg = minLegUsd("sol", 75); // $9
  // A target under the hurdle is lifted to it.
  const lifted = viableStrategy([{ kind: "tp", at: 5, sell: 100 }], 9, minLeg, 500, 0);
  assert.deepEqual(lifted, [{ kind: "tp", at: 9, sell: 100 }]);

  // A $20 position cannot afford a rung that nets $6.40 — it folds into the one above it.
  const merged = viableStrategy(
    [{ kind: "tp", at: 60, sell: 20 }, { kind: "tp", at: 150, sell: 30 }, { kind: "sl", at: -25, sell: 100 }],
    9,
    minLeg,
    20,
    0,
  );
  assert.deepEqual(merged, [{ kind: "tp", at: 150, sell: 50 }, { kind: "sl", at: -25, sell: 100 }]);

  // When no rung is big enough the ladder collapses to the single leg it could afford.
  const collapsed = viableStrategy([{ kind: "tp", at: 20, sell: 10 }, { kind: "tp", at: 30, sell: 10 }], 9, minLeg, 20, 0);
  assert.deepEqual(collapsed, [{ kind: "tp", at: 30, sell: 20 }]);

  // The same plan on a position ten times the size keeps every rung it was written with.
  const kept = viableStrategy([{ kind: "tp", at: 60, sell: 20 }, { kind: "tp", at: 150, sell: 30 }], 9, minLeg, 200, 0);
  assert.equal(kept.length, 2);
});

// The shape every position in the first live session ran on: a hurdle around +9%, a 25% stop, and
// an analyst rung at +17-21% that filled on the first or second candle. The floor is what stops
// that plan from being written, so this pins the exact rungs that session lost money on.
test("a profit target inside the stop distance is lifted out of the noise", () => {
  const minLeg = minLegUsd("sol", 75); // $9
  const plan = (rules: StrategyRule[], usd = 500) => viableStrategy(rules, 9, minLeg, usd, 25);

  assert.deepEqual(
    plan([{ kind: "tp", at: 20.5, sell: 45 }, { kind: "sl", at: -25, sell: 100 }]),
    [{ kind: "tp", at: 25, sell: 45 }, { kind: "sl", at: -25, sell: 100 }],
    "risking 25% to make 20.5% is inverted before fees",
  );

  // The floor lifts, it never lowers: a target already above it is left exactly as written.
  assert.deepEqual(plan([{ kind: "tp", at: 150, sell: 30 }]), [{ kind: "tp", at: 150, sell: 30 }]);

  // Stops are never touched — raising one would deepen a loss, not protect a gain.
  assert.deepEqual(
    plan([{ kind: "sl", at: -12, sell: 50 }, { kind: "sl", at: -20, sell: 100 }]),
    [{ kind: "sl", at: -12, sell: 50 }, { kind: "sl", at: -20, sell: 100 }],
  );

  // The higher floor binds, whichever it is: on a position small enough that the round trip costs
  // more than the stop distance, fees are what the target is lifted to.
  assert.deepEqual(
    viableStrategy([{ kind: "tp", at: 5, sell: 100 }], 30, minLeg, 500, 25),
    [{ kind: "tp", at: 30, sell: 100 }],
  );
});

test("dust: a remainder under $1 or under 2% of the buy closes the position", () => {
  assert.equal(isDust(position()), false);
  // 1.5% of the original quantity left — a rounding remainder from a 100% fill.
  assert.equal(isDust(position({ qty: 1_500 })), true);
  // 10% of the quantity left, but the price collapsed: under $1 is not worth another sell.
  assert.equal(isDust(position({ qty: 10_000, lastPrice: 0.00005 })), true);
  assert.equal(isDust(position({ qty: 10_000 })), false, "a real partial exit stays open");
});

// The server's SK buy: rows of +20% and +10% went in, one order at +25% came out.
test("a fixed strategy runs as written; only the analyst's plan is repriced", () => {
  const rows: StrategyRule[] = [{ kind: "tp", at: 20, sell: 50 }, { kind: "tp", at: 10, sell: 50 }, { kind: "sl", at: -25, sell: 100 }];
  const minLeg = minLegUsd("sol", 120);
  assert.deepEqual(pricedPlan({ ...DEFAULT_CONFIG, fixedStrategy: true }, rows, 14.7, minLeg, 14), rows);
  assert.deepEqual(pricedPlan({ ...DEFAULT_CONFIG, fixedStrategy: false }, rows, 14.7, minLeg, 14), [
    { kind: "tp", at: 25, sell: 100 },
    { kind: "sl", at: -25, sell: 100 },
  ]);
});
