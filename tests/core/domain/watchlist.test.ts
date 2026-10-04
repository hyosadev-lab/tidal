import { test } from "node:test";
import assert from "node:assert/strict";
import { WATCH_MAX, WATCH_MIN_MINUTES, WATCH_TTL_MINUTES, observe, pruneWatchlist, reviseWatchlist, ripe } from "../../../src/core/domain/watchlist.ts";
import { candidate } from "./fixtures.ts";

const MIN = 60_000;
const rows = ["a", "b", "c", "d"].map((address) => candidate({ address, symbol: address.toUpperCase(), priceUsd: 1, marketCapUsd: 1000 }));
const want = (...addresses: string[]) => addresses.map((address) => ({ address, note: "wait for a pullback" }));

test("the watchlist never grows past its cap, and only takes eligible rows of the sweep", () => {
  const r = reviseWatchlist([], want("a", "b", "nope", "c", "d", "a"), [], rows, "sol", 0);
  assert.deepEqual(r.list.map((w) => w.c.address), ["a", "b", "c"]);
  assert.equal(r.list.length, WATCH_MAX);
  assert.equal(r.list[0]?.note, "wait for a pullback");
  assert.match(r.notes.join("\n"), /not an eligible row/);
  assert.match(r.notes.join("\n"), /D not added — the watchlist is full/);

  const blocked = [candidate({ address: "x", gateFailures: ["honeypot"] })];
  assert.equal(reviseWatchlist([], want("x"), [], blocked, "sol", 0).list.length, 0);
});

test("an unwatch in the same answer frees the slot it held", () => {
  const full = reviseWatchlist([], want("a", "b", "c"), [], rows, "sol", 0).list;
  const r = reviseWatchlist(full, want("d"), [{ address: "B", reason: "buyers gone" }], rows, "sol", 0);
  assert.deepEqual(r.list.map((w) => w.c.address), ["a", "c", "d"]);
});

test("a token is buyable only once watched, and is dropped when it times out or cannot be bought", () => {
  const [w] = reviseWatchlist([], want("a"), [], rows, "sol", 0).list;
  assert.ok(w);
  assert.equal(ripe(w, (WATCH_MIN_MINUTES - 1) * MIN), false);
  assert.equal(ripe(w, WATCH_MIN_MINUTES * MIN), true);

  const free = () => "";
  assert.equal(pruneWatchlist([w], WATCH_TTL_MINUTES * MIN, "sol", free).list.length, 1);
  assert.equal(pruneWatchlist([w], WATCH_TTL_MINUTES * MIN + 1, "sol", free).list.length, 0);
  assert.equal(pruneWatchlist([w], 0, "sol", () => "already held").list.length, 0);
  assert.equal(pruneWatchlist([w], 0, "bsc", free).list.length, 0);
});

test("a fresh price moves the market cap with it and extends the trail", () => {
  const [w] = reviseWatchlist([], want("a"), [], [candidate({ address: "a", priceUsd: 1, marketCapUsd: 1000 })], "sol", 0).list;
  assert.ok(w);
  observe(w, 2, 5 * MIN);
  assert.equal(w.c.priceUsd, 2);
  assert.equal(w.c.marketCapUsd, 2000);
  assert.deepEqual(w.prices.map((p) => p.price), [1, 2]);
  observe(w, 0, 10 * MIN); // an unreadable price is not a price
  assert.equal(w.prices.length, 2);
});
