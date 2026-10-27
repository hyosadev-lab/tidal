import assert from "node:assert/strict";
import { test } from "node:test";
import { inFilters, rankFilters, sanitize, signalFilters } from "../src/config.ts";

const cfg = sanitize({
  filters: { ageMax: 120, marketCapMin: 30, initialLiquidityMin: 10, feeMin: 2, top10Max: 30, insiderMax: 150, bogusMin: 1 },
});

test("filters keep known keys, clamped, in GMGN trending's units", () => {
  assert.deepEqual(cfg.filters, { ageMax: 120, initialLiquidityMin: 10, marketCapMin: 30, feeMin: 2, top10Max: 30, insiderMax: 100 });
  assert.deepEqual(rankFilters(cfg), {
    max_created: "120m",
    min_marketcap: 30_000,
    min_gas_fee: 2,
    max_top10_holder_rate: 0.3,
    max_insider_rate: 1,
  }); // initial liquidity has no rank param
  assert.deepEqual(signalFilters(cfg), { mc_min: 30_000, total_fee_min: 2 });
});

test("inFilters checks a trending or signal row; a missing field passes", () => {
  const now = 1_800_000_000_000;
  const ts = now / 1000 - 60 * 60; // an hour old
  const rank = { creation_timestamp: ts, market_cap: 50_000, initial_liquidity: 12_000, gas_fee: 3, top_10_holder_rate: 0.2 };
  assert.equal(inFilters(rank, cfg, now), true);
  assert.equal(inFilters({ ...rank, initial_liquidity: 9_000 }, cfg, now), false);
  assert.equal(inFilters({ ...rank, creation_timestamp: ts - 2 * 3600 }, cfg, now), false);
  const signal = { created_timestamp: ts, market_cap: 50_000, total_fee: 1.5 };
  assert.equal(inFilters(signal, cfg, now), false); // fees under 2 SOL
  assert.equal(inFilters({ ...signal, total_fee: 2 }, cfg, now), true); // no initial_liquidity on signal rows
});
