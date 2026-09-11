import { test } from "node:test";
import assert from "node:assert/strict";
import { AUTO_SLIPPAGE_CAP } from "../../../src/core/domain/chains.ts";
import { DEFAULT_CONFIG, gasReserve, liveReady, minPosition, refineQuery, sanitizeConfig, slippage } from "../../../src/core/domain/config.ts";
import { trenchesFilters } from "../../../src/core/market/gmgn.ts";
import type { TradeConfig } from "../../../src/core/domain/types.ts";

// The clamps are safety limits, not input tidying — every one of them is pinned here.

const cfg: TradeConfig = { ...DEFAULT_CONFIG };

// ── config safety ─────────────────────────────────────────────────────

test("0 is the auto flag on the three fields that have one, not a real value", () => {
  const c = sanitizeConfig({ slippagePct: 0, gasReserveNative: 0 });
  assert.equal(c.slippagePct, 0);
  // Auto still has to produce a usable number for a paper fill and for sizing.
  assert.equal(slippage(c), AUTO_SLIPPAGE_CAP);
  assert.equal(minPosition(c), 3);
  assert.equal(gasReserve(c), 0.02);
  // A real value is kept, and an out-of-range one is clamped rather than read as auto.
  assert.equal(sanitizeConfig({ slippagePct: 5 }).slippagePct, 5);
  assert.equal(sanitizeConfig({ slippagePct: 900 }).slippagePct, 100);
  assert.equal(sanitizeConfig({ slippagePct: -3 }).slippagePct, 0);
});

test("out-of-range config is clamped rather than trusted", () => {
  const c = sanitizeConfig({ intervalMinutes: 0, stopLossPct: -5, maxOpenPositions: 999 });
  assert.equal(c.intervalMinutes, 1);
  assert.equal(c.stopLossPct, 5);
  assert.equal(c.maxOpenPositions, 20);
});

test("refine rows survive as query params, blanks and junk do not", () => {
  const c = sanitizeConfig({
    refine: { ageMin: 5, top10Max: 40, devHoldingMax: 0, insiderMax: 900, feeMin: -1, kolMax: "" as never, nonsense: 3 } as never,
  });
  assert.deepEqual(c.refine, { ageMin: 5, top10Max: 40, devHoldingMax: 0, insiderMax: 100, feeMin: 0 });
  assert.deepEqual(refineQuery(c.refine), {
    min_created: "5m",
    max_top10_holder_rate: 0.4,
    max_dev_team_hold_rate: 0,
    max_insider_rate: 1,
    min_gas_fee: 0,
  });
  // Same rows, the names /v1/trenches uses for them.
  assert.deepEqual(refineQuery(c.refine, "trenches"), {
    min_created: "5m",
    max_top_holder_rate: 0.4,
    max_creator_balance_rate: 0,
    max_insider_ratio: 1,
    min_total_fee: 0,
  });
});

test("a refine row can tighten the trenches preset but never loosen it", () => {
  const loose = trenchesFilters({ max_insider_ratio: 0.9, min_smart_degen_count: 0 });
  assert.equal(loose.max_insider_ratio, 0.3);
  assert.equal(loose.min_smart_degen_count, 1);

  const tight = trenchesFilters({ max_insider_ratio: 0.05, min_smart_degen_count: 4, min_created: "5m" });
  assert.equal(tight.max_insider_ratio, 0.05);
  assert.equal(tight.min_smart_degen_count, 4);
  assert.equal(tight.min_created, "5m");
  // Untouched preset fields still ship.
  assert.equal(tight.max_rug_ratio, 0.3);
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
