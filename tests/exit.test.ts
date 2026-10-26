import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../src/exit.ts";

const cfg = { timeStopMinutes: 30, liquidityDrainPct: 55 };
const p = { opened_at: 0, entry_price_usd: 1, entry_liquidity_usd: 10_000 };
const rules = [
  { id: 1, kind: "sl" as const, at_pct: -25, sell_pct: 100, filled_at: null },
  { id: 2, kind: "tp" as const, at_pct: 60, sell_pct: 40, filled_at: null },
  { id: 3, kind: "tp" as const, at_pct: 150, sell_pct: 30, filled_at: null },
  { id: 4, kind: "tp" as const, at_pct: 400, sell_pct: 30, filled_at: null },
];

test("exit rules: stop first, a gap through a ladder is one sell, filled rules stay quiet", () => {
  assert.equal(evaluate(p, rules, 1.1, 10_000, 60_000, cfg), null);
  assert.deepEqual(evaluate(p, rules, 0.74, 10_000, 60_000, cfg), { reason: "sl", pct: 100, ruleIds: [1] });
  assert.deepEqual(evaluate(p, rules, 2.6, 10_000, 60_000, cfg), { reason: "tp", pct: 70, ruleIds: [2, 3] });
  const filled = rules.map((r) => (r.id === 2 ? { ...r, filled_at: 1 } : r));
  assert.deepEqual(evaluate(p, filled, 2.6, 10_000, 60_000, cfg), { reason: "tp", pct: 30, ruleIds: [3] });
});

test("exit rules: health and the clock sell everything, the clock even with no price", () => {
  assert.equal(evaluate(p, rules, 1.1, 4_400, 60_000, cfg)?.reason, "health");
  assert.equal(evaluate(p, rules, 1.1, 4_600, 60_000, cfg), null);
  assert.deepEqual(evaluate(p, rules, null, null, 30 * 60_000, cfg), { reason: "time", pct: 100, ruleIds: [] });
  assert.equal(evaluate(p, rules, null, null, 60_000, cfg), null);
});
