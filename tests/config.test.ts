import assert from "node:assert/strict";
import { test } from "node:test";
import { inFilters, loadConfig, rankFilters, sanitize, saveConfig, signalFilters } from "../src/config.ts";
import { db, openDb } from "../src/db.ts";

const cfg = sanitize({
  filters: { ageMax: 120, marketCapMin: 30, initialLiquidityMin: 10, feeMin: 2, top10Max: 30, insiderMax: 150, bogusMin: 1 },
  signalFilters: { marketCapMin: 20, marketCapMax: 500, feeMin: 1, top10Max: 30, ageMax: 60 },
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
  // The signal route takes age, market cap and total fee only: the other bounds are dropped there, not ignored.
  assert.deepEqual(cfg.signalFilters, { ageMax: 60, marketCapMin: 20, marketCapMax: 500, feeMin: 1 });
  assert.deepEqual(signalFilters(cfg), { max_create_or_open_ts: "60m", mc_min: 20_000, mc_max: 500_000, total_fee_min: 1 });
});

test("inFilters checks a trending or signal row against its own feed's bounds; a missing field passes", () => {
  const now = 1_800_000_000_000;
  const ts = now / 1000 - 60 * 60; // an hour old
  const rank = { creation_timestamp: ts, market_cap: 50_000, initial_liquidity: 12_000, gas_fee: 3, top_10_holder_rate: 0.2 };
  assert.equal(inFilters(rank, cfg.filters, now), true);
  assert.equal(inFilters({ ...rank, initial_liquidity: 9_000 }, cfg.filters, now), false);
  assert.equal(inFilters({ ...rank, creation_timestamp: ts - 2 * 3600 }, cfg.filters, now), false);
  const sig = { created_timestamp: ts, market_cap: 40_000, total_fee: 2 };
  assert.equal(inFilters(sig, cfg.signalFilters, now), true);
  assert.equal(inFilters({ ...sig, market_cap: 3_000 }, cfg.signalFilters, now), false);
  assert.equal(inFilters({ ...sig, total_fee: 0.5 }, cfg.signalFilters, now), false);
  assert.equal(inFilters({ ...sig, created_timestamp: ts - 3600 }, cfg.signalFilters, now), false); // 2h old, ageMax 60
});

test("signal types: known ones the route takes, in order, once; none = the list off; absent = the default", () => {
  assert.deepEqual(sanitize({ signalTypes: [18, 12, 12, "20", 14, 15, 16, 21, 99] }).signalTypes, [12, 18, 20]); // 14–16: GMGN refuses them
  assert.deepEqual(sanitize({ signalTypes: [] }).signalTypes, []);
  assert.deepEqual(sanitize({}).signalTypes, [12, 18]);
});

test("every save lands in config_history too: the version trades and tracks are scored under", () => {
  openDb(":memory:");
  loadConfig(); // the first read writes the defaults: the first version
  saveConfig({ ...loadConfig(), prompt: "v2" });
  const last = db.prepare("select value from config_history order by at desc limit 1").get() as { value: string };
  assert.equal(JSON.parse(last.value).prompt, "v2");
  assert.equal(last.value, (db.prepare("select value from settings where key = 'config'").get() as { value: string }).value);
});

test("a save that changes nothing is no new version", () => {
  openDb(":memory:");
  loadConfig();
  saveConfig(loadConfig()); // Save with nothing changed, or Apply with the same filters
  saveConfig({ ...loadConfig() });
  assert.equal((db.prepare("select count(*) n from config_history").get() as { n: number }).n, 1);
});

test("a save that changes only the Filters modal's fields is no new version; anything else is", () => {
  openDb(":memory:");
  loadConfig();
  saveConfig({ ...loadConfig(), filters: { marketCapMin: 30 }, signalFilters: { feeMin: 2 }, signalTypes: [6, 12] });
  const n = () => (db.prepare("select count(*) n from config_history").get() as { n: number }).n;
  assert.equal(n(), 1);
  assert.deepEqual(loadConfig().signalTypes, [6, 12]); // the config itself is saved
  saveConfig({ ...loadConfig(), prompt: "v2" });
  assert.equal(n(), 2);
  // A version saved by an older release, with a key since dropped: a filter save is still no version.
  const old = { ...JSON.parse(JSON.stringify(loadConfig())), graduatedFilters: { ageMax: 120 } };
  db.prepare("update config_history set value = ? where at = (select max(at) from config_history)").run(JSON.stringify(old));
  saveConfig({ ...loadConfig(), signalTypes: [12] });
  assert.equal(n(), 2);
});
