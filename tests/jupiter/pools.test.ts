import { test } from "node:test";
import assert from "node:assert/strict";
import { b58decode, b58encode, WSOL } from "../../src/jupiter/client.ts";
import * as pools from "../../src/jupiter/pools.ts";

// The pool feed against a fake RPC and a fake socket: what it prices, and when it refuses to.

const key = (n: number) => b58encode(Buffer.alloc(32, n));
const MINT = key(1);
const POOL = key(2);
const BASE_VAULT = key(3);
const QUOTE_VAULT = key(4);
const CURVE_MINT = key(5);
const CURVE = key(6);

const u64 = (d: Buffer, at: number, v: bigint) => (d.writeBigUInt64LE(v, at), d);
const mint = (decimals: number) => Object.assign(Buffer.alloc(82), { 44: decimals });
const tokenAccount = (amount: bigint) => u64(Buffer.alloc(165), 64, amount);
function ammPool(virtualQuote = 0n): Buffer {
  const d = Buffer.alloc(301);
  d.writeBigUInt64LE(BigInt.asUintN(64, virtualQuote), 245), d.writeBigInt64LE(virtualQuote >> 64n, 253); // i128
  for (const [at, k] of [[43, MINT], [75, WSOL], [139, BASE_VAULT], [171, QUOTE_VAULT]] as const) b58decode(k).copy(d, at);
  return d;
}
function curve(vTok: bigint, vSol: bigint, realSol: bigint, complete = false): Buffer {
  const d = Buffer.alloc(150);
  u64(d, 8, vTok), u64(d, 16, vSol), u64(d, 32, realSol);
  d[48] = complete ? 1 : 0;
  return d;
}

// ── fake chain ──
const chain = new Map<string, { owner: string; data: Buffer }>();
let slot = 10;
globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
  const { method, params } = JSON.parse(String(init?.body));
  assert.equal(method, "getMultipleAccounts");
  const value = (params[0] as string[]).map((k) => {
    const a = chain.get(k);
    return a ? { owner: a.owner, data: [a.data.toString("base64"), "base64"] } : null;
  });
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot }, value } }));
}) as typeof fetch;

// ── fake socket ──
class FakeSocket {
  static last: FakeSocket | null = null;
  sent: any[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeSocket.last = this;
  }
  send(s: string) {
    this.sent.push(JSON.parse(s));
  }
  close() {}
  reply(m: object) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
}
(globalThis as any).WebSocket = FakeSocket;
const settle = () => new Promise((r) => setTimeout(r, 20));

test("layouts: a PumpSwap pool names its vaults, a curve prices off virtual reserves, others are not read", () => {
  assert.deepEqual(pools.decodePool(pools.PUMP_AMM, ammPool()), { kind: "amm", baseMint: MINT, quoteMint: WSOL, baseVault: BASE_VAULT, quoteVault: QUOTE_VAULT });
  assert.deepEqual(pools.decodePool(pools.PUMP_CURVE, curve(1n, 1n, 1n)), { kind: "curve" });
  assert.equal(pools.decodePool(key(9), ammPool()), null);
  // 1,000,000 tokens (6 decimals) against 30 virtual SOL: 0.00003 SOL each; 5 real SOL is the liquidity.
  assert.deepEqual(pools.curveReading(curve(1_000_000_000_000n, 30_000_000_000n, 5_000_000_000n), 6), { price: 0.00003, liquidity: 5 });
  assert.equal(pools.curveReading(curve(1n, 1n, 1n, true), 6), "complete");
  assert.equal(pools.curveQuote(curve(1n, 1n, 1n)), WSOL); // an empty quote field: a SOL launch
});

test("PumpSwap: priced off the vaults plus the pool's virtual quote, on first read, then only when both vaults agree on a slot", async () => {
  chain.set(POOL, { owner: pools.PUMP_AMM, data: ammPool(25_000_000_000n) }); // 25 virtual SOL
  chain.set(MINT, { owner: "token", data: mint(6) });
  chain.set(WSOL, { owner: "token", data: mint(9) });
  chain.set(BASE_VAULT, { owner: "token", data: tokenAccount(2_000_000_000_000n) }); // 2,000,000 tokens
  chain.set(QUOTE_VAULT, { owner: "token", data: tokenAccount(100_000_000_000n) }); // 100 SOL

  await pools.watch(MINT, POOL);
  assert.equal(pools.reading(MINT)?.price, 125 / 2_000_000);
  assert.equal(pools.reading(MINT)?.liquidity, 100, "liquidity is the real reserve");
  assert.deepEqual(pools.quoteMints(), [WSOL]);

  pools.tick();
  const sock = FakeSocket.last!;
  sock.onopen!();
  assert.ok(pools.socketUp());
  const asks = sock.sent.filter((m) => m.method === "accountSubscribe");
  assert.deepEqual(asks.map((m) => m.params[0]).sort(), [BASE_VAULT, QUOTE_VAULT, POOL].sort());
  assert.ok(sock.sent.some((m) => m.method === "slotSubscribe"), "a heartbeat is asked for");
  const subOf = new Map<string, number>();
  asks.forEach((m, i) => (subOf.set(m.params[0], 100 + i), sock.reply({ jsonrpc: "2.0", id: m.id, result: 100 + i })));
  await settle(); // the resync poll the open started

  const moves: string[] = [];
  const onPrice = (e: Event) => moves.push((e as CustomEvent<string>).detail);
  pools.feed.addEventListener("price", onPrice);
  const push = (acc: string, data: Buffer, at: number) =>
    sock.reply({ jsonrpc: "2.0", method: "accountNotification", params: { subscription: subOf.get(acc), result: { context: { slot: at }, value: { data: [data.toString("base64"), "base64"] } } } });

  // A buy: tokens leave the base vault, SOL enters the quote vault, both in slot 20.
  push(BASE_VAULT, tokenAccount(1_600_000_000_000n), 20);
  assert.equal(pools.reading(MINT)?.price, 125 / 2_000_000, "one vault seen: not priced yet");
  push(QUOTE_VAULT, tokenAccount(125_000_000_000n), 20);
  assert.equal(pools.reading(MINT)?.price, 150 / 1_600_000);
  assert.deepEqual(moves, [MINT]);
  push(POOL, ammPool(20_000_000_000n), 21); // the virtual reserve drifts on its own
  assert.equal(pools.reading(MINT)?.price, 145 / 1_600_000);

  push(BASE_VAULT, tokenAccount(1n), 19);
  push(QUOTE_VAULT, tokenAccount(1n), 19);
  assert.equal(pools.reading(MINT)?.price, 145 / 1_600_000, "an older slot is dropped");
  pools.feed.removeEventListener("price", onPrice);

  pools.tick(Date.now() + 16_000);
  assert.equal(pools.socketUp(), false, "15 s of silence, heartbeat included, drops the socket");

  pools.unwatch(MINT);
  assert.equal(pools.reading(MINT), null);
  assert.deepEqual(pools.watching(), []);
  pools.tick();
  await settle();
});

test("a curve that completes is off, and so is a pool no one can read", async () => {
  chain.set(CURVE, { owner: pools.PUMP_CURVE, data: curve(1_000_000_000_000n, 30_000_000_000n, 5_000_000_000n) });
  chain.set(CURVE_MINT, { owner: "token", data: mint(6) });
  await pools.watch(CURVE_MINT, CURVE);
  assert.equal(pools.reading(CURVE_MINT)?.price, 0.00003);

  chain.set(CURVE, { owner: pools.PUMP_CURVE, data: curve(0n, 0n, 0n, true) });
  slot = 30;
  pools.tick(Date.now() + 60_000); // socket not open: the backup poll reads it
  await settle();
  assert.equal(pools.reading(CURVE_MINT), null);
  assert.equal(pools.offReason(CURVE_MINT), "curve complete");

  await pools.watch(MINT, key(9));
  assert.match(pools.offReason(MINT) ?? "", /pool account not found/);

  for (const m of pools.watching()) pools.unwatch(m);
  pools.tick();
});

test("a curve quoted in another token is priced in that token, with its decimals", async () => {
  const [QUOTE, QCURVE, QMINT] = [key(11), key(12), key(13)];
  const d = curve(1_000_000_000_000n, 30_000_000n, 5_000_000n); // 30 and 5 of a 6-decimal quote
  b58decode(QUOTE).copy(d, 83);
  chain.set(QCURVE, { owner: pools.PUMP_CURVE, data: d });
  chain.set(QMINT, { owner: "token", data: mint(6) });
  chain.set(QUOTE, { owner: "token", data: mint(6) });
  const r = await pools.resolvePool(QMINT, QCURVE);
  assert.ok(typeof r !== "string");
  assert.deepEqual([r.quoteMint, r.decimals], [QUOTE, [6, 6]]);
  assert.deepEqual(pools.poolReading(r, r.data), { price: 0.00003, liquidity: 5 });

  await pools.watch(QMINT, QCURVE); // the exit loop's feed: priced in QUOTE, turned into USD by the caller
  assert.deepEqual([pools.reading(QMINT)?.price, pools.reading(QMINT)?.quoteMint], [0.00003, QUOTE]);
  for (const m of pools.watching()) pools.unwatch(m);
  pools.tick();
});

test("addresses: a pump token's curve and the PumpSwap pool it migrates into, off the mint alone", () => {
  // Pairs GMGN reported for real tokens.
  assert.equal(pools.curveOf("2KH3rv7PoDa3nwyzRqd7Tfq365aGRSzb8vEujRWrpump"), "3LoJoiLH3vimphQfrjCtw6T2hrFUG1gy4uwohweBqWFK");
  assert.equal(pools.migratedPool("E6exteuDy1u6u3FfQV7SvPyU4XPdcBGi4cBnqrusocat"), "5sPzRxRMyaX85fAwNC61kvifvH63JUwt4viZkUNno4wd");
  assert.equal(
    pools.migratedPool("93FWFR63nwQcq5zuXNmTits5BYcKFjmUZzccMvhmpump", "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn"),
    "646NHe5TmrAHa6y6TxGBnW94bhu5sgXCqMH6oLD1pkvb",
  );
});

test("PumpSwap: the virtual quote is a signed i128, so a negative one lowers the price", () => {
  const r = { kind: "amm" as const, decimals: [6, 9] };
  const vaults = [tokenAccount(2_000_000_000_000n), tokenAccount(100_000_000_000n)]; // 2,000,000 tokens, 100 SOL
  assert.equal(pools.ammVirtualQuote(ammPool(-5_000_000_000n)), -5_000_000_000n);
  assert.equal((pools.poolReading(r, [...vaults, ammPool(-5_000_000_000n)]) as { price: number }).price, 95 / 2_000_000);
  assert.equal(pools.poolReading(r, [...vaults, ammPool(-100_000_000_000n)]), null, "no positive quote side, no price");
});
