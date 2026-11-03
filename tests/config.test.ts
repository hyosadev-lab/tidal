import assert from "node:assert/strict";
import { test } from "node:test";
import { inFilters, loadConfig, rankFilters, sanitize, saveConfig, trenchesFilters } from "../src/config.ts";
import { db, openDb } from "../src/db.ts";

const cfg = sanitize({
  filters: { ageMax: 120, marketCapMin: 30, initialLiquidityMin: 10, feeMin: 2, top10Max: 30, insiderMax: 150, bogusMin: 1 },
  graduatedFilters: { ageMax: 30, initialLiquidityMin: 10, athMarketCapMin: 50, volumeMin: 20, top10Max: 30, devHoldingMax: 5 },
});

test("filters keep known keys, clamped, in GMGN's units, each feed under its own route's params", () => {
  assert.deepEqual(cfg.filters, { ageMax: 120, initialLiquidityMin: 10, marketCapMin: 30, feeMin: 2, top10Max: 30, insiderMax: 100 });
  assert.deepEqual(rankFilters(cfg), {
    max_created: "120m",
    min_marketcap: 30_000,
    min_gas_fee: 2,
    max_top10_holder_rate: 0.3,
    max_insider_rate: 1,
  }); // initial liquidity has no rank param
  // Trenches rows carry no initial liquidity or ATH: those bounds are dropped there, not ignored.
  assert.deepEqual(cfg.graduatedFilters, { ageMax: 30, volumeMin: 20, top10Max: 30, devHoldingMax: 5 });
  assert.deepEqual(trenchesFilters(cfg), { max_created: "30m", min_volume_24h: 20_000, max_top_holder_rate: 0.3 }); // dev holding: on the row
});

test("inFilters checks a trending or trenches row against its own feed's bounds; a missing field passes", () => {
  const now = 1_800_000_000_000;
  const ts = now / 1000 - 60 * 60; // an hour old
  const rank = { creation_timestamp: ts, market_cap: 50_000, initial_liquidity: 12_000, gas_fee: 3, top_10_holder_rate: 0.2 };
  assert.equal(inFilters(rank, cfg.filters, now), true);
  assert.equal(inFilters({ ...rank, initial_liquidity: 9_000 }, cfg.filters, now), false);
  assert.equal(inFilters({ ...rank, creation_timestamp: ts - 2 * 3600 }, cfg.filters, now), false);
  const trench = { created_timestamp: now / 1000 - 10 * 60, volume_24h: 25_000, top_10_holder_rate: 0.2, dev_team_hold_rate: 0.01 };
  assert.equal(inFilters(trench, cfg.graduatedFilters, now), true);
  assert.equal(inFilters({ ...trench, dev_team_hold_rate: 0.2 }, cfg.graduatedFilters, now), false); // no trenches param: the row check holds it
  assert.equal(inFilters({ ...trench, volume_24h: 5_000 }, cfg.graduatedFilters, now), false);
  assert.equal(inFilters({ ...trench, created_timestamp: ts }, cfg.graduatedFilters, now), false); // an hour old, over 30 minutes
});

test("every save lands in config_history too: the version trades and tracks are scored under", () => {
  openDb(":memory:");
  loadConfig(); // the first read writes the defaults: the first version
  saveConfig({ ...loadConfig(), prompt: "v2" });
  const last = db.prepare("select value from config_history order by at desc limit 1").get() as { value: string };
  assert.equal(JSON.parse(last.value).prompt, "v2");
  assert.equal(last.value, (db.prepare("select value from settings where key = 'config'").get() as { value: string }).value);
});
