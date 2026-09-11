import { test } from "node:test";
import assert from "node:assert/strict";
import { toCandidate } from "../../../src/core/domain/candidates.ts";
import { candidate } from "./fixtures.ts";

// A feed row becoming a Candidate: the one place the two feeds' disagreeing columns are
// reconciled, so a wrong name here is a silent zero everywhere downstream.

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
      price_change_percent1h: 42,
      creation_timestamp: Math.floor(Date.now() / 1000) - 3600,
    },
    "trending",
  );
  assert.equal(c.symbol, "WIF");
  assert.equal(c.liquidityUsd, 120_000);
  assert.equal(c.devHolding, false);
  assert.ok(Math.abs(c.change1hPct - 42) < 0.01, "percent passed through, not rescaled");
  assert.ok(c.ageMinutes > 55 && c.ageMinutes < 65);
});

// Live field names, checked against both feeds. The rank feed carries per-minute change and
// gas_fee but no net buy and no insider rate; trenches is the mirror image, under its own
// names. Whichever half is missing must arrive as null: a rate of 0 is a claim ("no insiders
// here"), and reading a blank as that claim is the expensive mistake available here.
test("feed-specific fields map by name, and what a feed omits stays null", () => {
  const rank = toCandidate(
    {
      address: "abc",
      price: 1,
      price_change_percent1m: 7.1,
      buys: 51_309,
      sells: 48_171,
      dev_team_hold_rate: 0.198,
      bundler_rate: 0.84,
      gas_fee: 279.4,
    },
    "trending",
  );
  assert.equal(rank.change1mPct, 7.1);
  assert.deepEqual([rank.buys, rank.sells], [51_309, 48_171]);
  assert.equal(rank.devHoldRate, 0.198);
  assert.equal(rank.bundlerRate, 0.84);
  assert.equal(rank.feeUsd, 279.4);
  assert.equal(rank.netBuyUsd, null, "the rank feed has no net buy — not a net buy of zero");
  assert.equal(rank.insiderRate, null, "nor an insider rate");

  const trench = toCandidate(
    {
      address: "def",
      price: 1,
      buys_24h: 1990,
      sells_24h: 2040,
      net_buy_24h: 4460.57,
      suspected_insider_hold_rate: 0.02,
      bundler_trader_amount_rate: 0.2179,
      total_fee: 7.08,
    },
    "graduated",
  );
  assert.deepEqual([trench.buys, trench.sells], [1990, 2040]);
  assert.equal(trench.netBuyUsd, 4460.57);
  assert.equal(trench.insiderRate, 0.02);
  assert.equal(trench.bundlerRate, 0.2179, "trenches names the bundler rate differently");
  assert.equal(trench.feeUsd, 7.08);
  assert.equal(trench.change1mPct, null, "trenches carries no price change at all");

  // An empty string is how GMGN sends "not measured" on some rows; it is not a zero either.
  assert.equal(toCandidate({ address: "x", price: 1, gas_fee: "" }, "t").feeUsd, null);
  assert.equal(toCandidate({ address: "x", price: 1, dev_team_hold_rate: 0 }, "t").devHoldRate, 0, "a real zero survives");
});

// The 5m feed sends the same column names as the 1h one, measured over five minutes — one row
// only ever carries one window, so `toCandidate` reads it into the unsuffixed fields and the
// sweep is what copies it across onto the hourly row. Anything that changes that mapping
// silently turns the brief's acceleration reading into an hour compared against itself.
test("a 5m feed row lands in the unsuffixed fields, and the 5m ones stay blank", () => {
  const row = { address: "abc", price: 1, buys: 206, sells: 117, volume: 11_802 };
  const c = toCandidate(row, "trending-5m");
  assert.deepEqual([c.buys, c.sells, c.volume1hUsd], [206, 117, 11_802]);
  assert.deepEqual(
    [c.buys5m, c.sells5m, c.volume5mUsd],
    [null, null, null],
    "a row cannot fill its own second window — gatherCandidates copies these onto the 1h row",
  );
});
