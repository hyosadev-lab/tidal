import { test } from "node:test";
import assert from "node:assert/strict";
import { db, insert, openDb } from "../src/db.ts";
import { b58decode, b58encode, WSOL } from "../src/jupiter/client.ts";
import { migratedPool, PUMP_AMM, PUMP_CURVE } from "../src/jupiter/pools.ts";
import { loadConfig } from "../src/config.ts";
import { endRestarted, outcome, pickSignals, SAMPLES_PER_MIN, shadowTick, track, tracking, WINDOW_MS, type Point } from "../src/shadow.ts";
import { signalName } from "../src/snapshot.ts";
import { noteSol } from "../src/trade.ts";

// Shadow tracks against a fake RPC: a pump curve priced every step, written once when it ends.

const key = (n: number) => b58encode(Buffer.alloc(32, n));
const MINT = key(1);
const CURVE = key(2);
const ELSEWHERE = key(3);
const QUOTE = key(4);
const none = { decision: 0, signal: 0 };

const u64 = (d: Buffer, at: number, v: bigint) => (d.writeBigUInt64LE(v, at), d);
const mint = (decimals: number) => ({ owner: key(9), data: Object.assign(Buffer.alloc(82), { 44: decimals }) });
/** 1e6 tokens (6 decimals) against `vQuote` virtual quote; `real` is the liquidity. A `quote` other than SOL goes at byte 83. */
const curve = (vQuote: number, real: number, quote?: string, quoteDecimals = 9) => {
  const d = Buffer.alloc(166);
  u64(d, 8, 1_000_000_000_000n), u64(d, 16, BigInt(vQuote * 10 ** quoteDecimals)), u64(d, 32, BigInt(real * 10 ** quoteDecimals));
  if (quote) b58decode(quote).copy(d, 83);
  return { owner: PUMP_CURVE, data: d };
};

const chain = new Map<string, { owner: string; data: Buffer }>();
chain.set(MINT, mint(6));
chain.set(WSOL, mint(9));
chain.set(QUOTE, mint(6));
chain.set(ELSEWHERE, { owner: key(8), data: Buffer.alloc(300) });
const setCurve = (vSol: number, realSol: number) => chain.set(CURVE, curve(vSol, realSol));
globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
  if (String(url).includes("/price/")) // Jupiter: SOL $200, QUOTE $2
    return new Response(JSON.stringify({ [WSOL]: { usdPrice: 200 }, [QUOTE]: { usdPrice: 2 } }));
  const { method, params } = JSON.parse(String(init?.body));
  assert.equal(method, "getMultipleAccounts");
  const value = (params[0] as string[]).map((k) => {
    const a = chain.get(k);
    return a ? { owner: a.owner, data: [a.data.toString("base64"), "base64"] } : null;
  });
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value } }));
}) as typeof fetch;

function decided(token: string): number {
  if (!db.prepare("select 1 from tokens where address = ?").get(token)) insert("tokens", { address: token, first_seen_at: 1 });
  const run = insert("agent_runs", { started_at: 1, model: "m", status: "ok" });
  return insert("decisions", { run_id: run, token, action: "skip" });
}
const row = (decisionId: number) => db.prepare("select * from shadow_tracks where decision_id = ?").get(decisionId) as Record<string, any>;

test("outcome: each horizon takes the last point within 30s, extremes, and −100 after a rug", () => {
  const pts: Point[] = [];
  pts[0] = [0, 10];
  pts[25] = [5, 11]; // 50s: stands for 1 min
  pts[150] = [-3, 9];
  pts[1800] = [12, 15];
  const o = outcome(pts, false);
  assert.deepEqual([o.ret_1m, o.ret_5m, o.ret_15m, o.ret_30m, o.ret_60m], [5, -3, null, null, 12]);
  assert.deepEqual([o.max_pct, o.max_at, o.min_pct, o.min_at], [12, 3600, -3, 300]);

  const rug: Point[] = [[0, 10]];
  rug[20] = [20, 12];
  rug[40] = [-1, 0.2]; // drained at 80s
  const r = outcome(rug, true);
  assert.deepEqual([r.ret_1m, r.ret_5m, r.ret_60m], [20, -100, -100]);
  assert.deepEqual([r.max_pct, r.max_at, r.min_pct, r.min_at], [20, 40, -100, 80]);
  assert.equal(outcome([], false).max_pct, null);
});

test("a decided token is followed off its curve for the whole window, then written once", async () => {
  openDb(":memory:");
  noteSol(200);
  setCurve(30, 10); // 3e-5 SOL a token
  const id = decided(MINT);
  const t0 = Date.now();
  track(id, MINT, { symbol: "X", pool_address: CURVE }, t0);
  assert.equal(row(id).ended_at, null);

  await shadowTick(t0 + 2_000);
  assert.ok(Math.abs(row(id).start_price_usd - 3e-5 * 200) < 1e-12);
  setCurve(33, 12); // +10%
  await shadowTick(t0 + 60_000);
  setCurve(27, 8); // −10%
  await shadowTick(t0 + WINDOW_MS);

  const r = row(id);
  assert.equal(r.end_reason, "done");
  assert.deepEqual(tracking(), none);
  assert.deepEqual(JSON.parse(r.features), { symbol: "X", pool_address: CURVE });
  const path = JSON.parse(r.path) as Point[];
  assert.equal(path.length, 1801);
  assert.deepEqual([path[1], path[30], path[1800]], [[0, 10], [10, 12], [-10, 8]]);
  assert.deepEqual([r.ret_1m, r.ret_5m, r.ret_60m, r.max_pct, r.min_pct], [10, null, -10, 10, -10]);
});

test("a curve that completes is followed into the PumpSwap pool it migrated to", async () => {
  openDb(":memory:");
  noteSol(200);
  setCurve(30, 10);
  const id = decided(MINT);
  const t0 = Date.now();
  track(id, MINT, { pool_address: CURVE }, t0);
  await shadowTick(t0 + 2_000);

  chain.set(CURVE, { owner: PUMP_CURVE, data: Object.assign(curve(30, 10).data, { 48: 1 }) }); // complete
  await shadowTick(t0 + 4_000);
  const [pool, base, quote] = [migratedPool(MINT), key(21), key(22)];
  const d = Buffer.alloc(301);
  for (const [at, k] of [[43, MINT], [75, WSOL], [139, base], [171, quote]] as const) b58decode(k).copy(d, at);
  chain.set(pool, { owner: PUMP_AMM, data: d });
  chain.set(base, { owner: key(9), data: u64(Buffer.alloc(165), 64, 1_000_000_000_000n) }); // 1e6 tokens
  chain.set(quote, { owner: key(9), data: u64(Buffer.alloc(165), 64, 36_000_000_000n) }); // 36 SOL: +20%
  await shadowTick(t0 + 14_000); // the pool is found
  await shadowTick(t0 + 16_000);
  await shadowTick(t0 + WINDOW_MS);
  const r = row(id);
  assert.equal(r.end_reason, "done");
  assert.deepEqual(JSON.parse(r.path)[8], [20, 36]);
});

test("a curve in another quote is tracked in SOL at that quote's price", async () => {
  openDb(":memory:");
  noteSol(200);
  const QCURVE = key(5);
  chain.set(QCURVE, curve(30, 5, QUOTE, 6)); // 3e-5 QUOTE a token, 5 QUOTE deep; QUOTE = 0.01 SOL
  const id = decided(MINT);
  const t0 = Date.now();
  track(id, MINT, { pool_address: QCURVE }, t0);
  await shadowTick(t0 + 2_000);
  await shadowTick(t0 + WINDOW_MS);
  const r = row(id);
  assert.equal(r.end_reason, "done");
  assert.deepEqual(JSON.parse(r.path)[1], [0, 0.05]);
  assert.ok(Math.abs(r.start_price_usd - 3e-5 * 2) < 1e-12);
});

test("a drained pool ends as a rug; a pool off the feed, or none, ends at once; a restart cuts what is open", async () => {
  openDb(":memory:");
  noteSol(200);
  setCurve(30, 10);
  const [rug, other, nopool] = [decided(MINT), decided(MINT), decided(MINT)];
  const t0 = Date.now();
  track(rug, MINT, { pool_address: CURVE }, t0);
  track(other, MINT, { pool_address: ELSEWHERE }, t0);
  track(nopool, MINT, {}, t0);

  await shadowTick(t0 + 2_000);
  assert.equal(row(other).end_reason, "unreadable");
  assert.equal(row(other).path, null);
  assert.equal(row(nopool).end_reason, "unreadable");
  assert.equal(row(rug).ended_at, null);

  setCurve(30, 0.4); // under 5% of the first 10 SOL
  await shadowTick(t0 + 4_000);
  const r = row(rug);
  assert.equal(r.end_reason, "rug");
  assert.deepEqual([r.ret_1m, r.ret_60m, r.min_pct, r.min_at], [-100, -100, -100, 4]);
  assert.deepEqual(tracking(), none);

  const open = decided(MINT);
  insert("shadow_tracks", { token: MINT, source: "decision", decision_id: open, features: "{}", started_at: t0 });
  assert.equal(endRestarted(t0 + 9), 1);
  assert.deepEqual([row(open).end_reason, row(open).ended_at], ["restart", t0 + 9]);
});

test("signal picks: unpicked types only, fresh, pump, in filters, once per token × type, never decided, 5 a minute", () => {
  openDb(":memory:");
  const now = Date.now();
  const cfg = { ...loadConfig(), signalTypes: [12], signalFilters: { marketCapMin: 10 } }; // ≥ $10K
  const pump = { launchpad_platform: "Pump.fun", exchange: "pump", market_cap: "20000" };
  const ev = (token: string, type: number, agoS: number, data: Record<string, unknown> = {}) =>
    ({ token_address: token, signal_type: type, trigger_at: Math.floor((now - agoS * 1000) / 1000), trigger_mc: 20000, data: { ...pump, ...data } });
  decided("F");
  insert("shadow_tracks", { token: "G", source: "signal", features: JSON.stringify({ signal_type: signalName(6) }), started_at: 1 });
  const events = [
    ev("A", 6, 30), ev("A", 6, 31), ev("A", 7, 20), // two types of one token: two picks; the repeat: none
    ev("B", 12, 5), // a type the Signals list fetches: tracked as a decision, if at all
    ev("C", 6, 600), // fired 10 min ago: stale
    ev("D", 6, 5, { exchange: "raydium" }), // a pool not read on-chain
    ev("E", 6, 5, { market_cap: "5000" }), // under the Signals filters
    ev("F", 6, 5), // decided before
    ev("G", 6, 5), // this token × type is tracked already
    ...["H", "I", "J", "K"].map((t, i) => ev(t, 1, 100 - i * 10)),
  ];
  // Six left; five a minute, oldest first: A at 20s waits for next minute.
  const got = pickSignals(events, cfg, now).map((p) => `${p.token}${p.type}`);
  assert.deepEqual(got, ["H1", "I1", "J1", "K1", "A6"]);
  assert.equal(SAMPLES_PER_MIN, 5);
  assert.deepEqual(pickSignals(events, { ...cfg, signalTypes: [1, 6, 7, 12] }, now), []);
});
