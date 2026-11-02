import { test } from "node:test";
import assert from "node:assert/strict";
import { db, insert, openDb } from "../src/db.ts";
import { b58encode } from "../src/jupiter/client.ts";
import { PUMP_CURVE } from "../src/jupiter/pools.ts";
import { endRestarted, outcome, shadowTick, track, tracking, WINDOW_MS, type Point } from "../src/shadow.ts";
import { noteSol } from "../src/trade.ts";

// Shadow tracks against a fake RPC: a pump curve priced every step, written once when it ends.

const key = (n: number) => b58encode(Buffer.alloc(32, n));
const MINT = key(1);
const CURVE = key(2);
const ELSEWHERE = key(3);

const u64 = (d: Buffer, at: number, v: bigint) => (d.writeBigUInt64LE(v, at), d);
/** 1e6 tokens (6 decimals) against `vSol` virtual SOL; `realSol` is the liquidity. */
const curve = (vSol: number, realSol: number) => {
  const d = Buffer.alloc(150);
  u64(d, 8, 1_000_000_000_000n), u64(d, 16, BigInt(vSol * 1e9)), u64(d, 32, BigInt(realSol * 1e9));
  return d;
};

const chain = new Map<string, { owner: string; data: Buffer }>();
chain.set(MINT, { owner: key(9), data: Object.assign(Buffer.alloc(82), { 44: 6 }) });
chain.set(ELSEWHERE, { owner: key(8), data: Buffer.alloc(300) });
const setCurve = (vSol: number, realSol: number) => chain.set(CURVE, { owner: PUMP_CURVE, data: curve(vSol, realSol) });
globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
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
  assert.equal(tracking(), 0);
  assert.deepEqual(JSON.parse(r.features), { symbol: "X", pool_address: CURVE });
  const path = JSON.parse(r.path) as Point[];
  assert.equal(path.length, 1801);
  assert.deepEqual([path[1], path[30], path[1800]], [[0, 10], [10, 12], [-10, 8]]);
  assert.deepEqual([r.ret_1m, r.ret_5m, r.ret_60m, r.max_pct, r.min_pct], [10, null, -10, 10, -10]);
});

test("a drained pool ends as a rug; a pool off the feed, or none, ends at once; a restart cuts what is open", async () => {
  openDb(":memory:");
  noteSol(200);
  setCurve(30, 10);
  const [rug, other, none] = [decided(MINT), decided(MINT), decided(MINT)];
  const t0 = Date.now();
  track(rug, MINT, { pool_address: CURVE }, t0);
  track(other, MINT, { pool_address: ELSEWHERE }, t0);
  track(none, MINT, {}, t0);

  await shadowTick(t0 + 2_000);
  assert.equal(row(other).end_reason, "unreadable");
  assert.equal(row(other).path, null);
  assert.equal(row(none).end_reason, "unreadable");
  assert.equal(row(rug).ended_at, null);

  setCurve(30, 0.4); // under 5% of the first 10 SOL
  await shadowTick(t0 + 4_000);
  const r = row(rug);
  assert.equal(r.end_reason, "rug");
  assert.deepEqual([r.ret_1m, r.ret_60m, r.min_pct, r.min_at], [-100, -100, -100, 4]);
  assert.equal(tracking(), 0);

  const open = decided(MINT);
  insert("shadow_tracks", { token: MINT, source: "decision", decision_id: open, features: "{}", started_at: t0 });
  assert.equal(endRestarted(t0 + 9), 1);
  assert.deepEqual([row(open).end_reason, row(open).ended_at], ["restart", t0 + 9]);
});
