import { createHash } from "node:crypto";
import { b58decode, b58encode, rpc, rpcUrl, WSOL } from "./client.ts";

/**
 * Exit prices off each pool's own reserves, on-chain: no Jupiter call. A Solana RPC WebSocket
 * pushes every change of the watched accounts (`accountSubscribe`, standard RPC, no paid plan);
 * one `getMultipleAccounts` read of the same accounts backs it up — the first read, a resync
 * every RESYNC_MS, every DOWN_POLL_MS while the socket is down. A `slotSubscribe` heartbeat
 * tells a live socket from a half-open one.
 *
 * Two layouts are read: a pump.fun bonding curve (one account holds both reserves) and a
 * PumpSwap pool (two vault token accounts, paired by slot, so a swap seen on one vault only is
 * never priced). Anything else is `off`, and the exit loop prices it on Jupiter. Prices are in
 * the pool's quote token; turning them into USD is the caller's.
 *
 * Driven by `tick()` from the exit loop: no timer of its own, nothing runs while nothing is watched.
 */

export const PUMP_CURVE = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const PUMP_AMM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

const RESYNC_MS = 10_000;
const DOWN_POLL_MS = 1_000;
/** No message at all, slot heartbeat included, for this long: the socket is dead. */
const SILENT_MS = 15_000;
/** A pool read that failed on the network is tried again after this. */
const RETRY_MS = 30_000;
const COMMITMENT = "confirmed";

// ── layouts (pure) ────────────────────────────────────────────────────

export type PoolLayout = { kind: "curve" } | { kind: "amm"; baseMint: string; quoteMint: string; baseVault: string; quoteVault: string };

/** Which accounts hold a pool's reserves, off its account and owner program; null for any other program. */
export function decodePool(owner: string, d: Buffer): PoolLayout | null {
  if (owner === PUMP_CURVE && d.length >= 49) return { kind: "curve" };
  if (owner !== PUMP_AMM || d.length < 203) return null;
  // Anchor discriminator 8, bump 1, index 2, creator 32, then base/quote/lp mints and the two vaults.
  const key = (at: number) => b58encode(d.subarray(at, at + 32));
  return { kind: "amm", baseMint: key(43), quoteMint: key(75), baseVault: key(139), quoteVault: key(171) };
}

/**
 * A bonding curve's price (quote per token) and liquidity (real quote reserve), or "complete" once
 * it has migrated. The reserves are named SOL in pump's layout but are in the curve's quote token.
 */
export function curveReading(d: Buffer, decimals: number, quoteDecimals = 9): { price: number; liquidity: number } | "complete" | null {
  if (d[48]) return "complete";
  const tokens = Number(d.readBigUInt64LE(8)) / 10 ** decimals; // virtual token reserves
  const quote = Number(d.readBigUInt64LE(16)) / 10 ** quoteDecimals; // virtual quote reserves
  return tokens > 0 ? { price: quote / tokens, liquidity: Number(d.readBigUInt64LE(32)) / 10 ** quoteDecimals } : null;
}

/** A curve's quote mint: SOL when the field is empty (every SOL launch), else the mint written at byte 83. */
export function curveQuote(d: Buffer): string {
  const at = d.subarray(83, 115);
  return at.length < 32 || at.every((b) => b === 0) ? WSOL : b58encode(at);
}

// ── addresses (pure) ──────────────────────────────────────────────────

const P = 2n ** 255n - 19n;
const powMod = (b: bigint, e: bigint): bigint => {
  let r = 1n;
  for (b %= P; e > 0n; e >>= 1n, b = (b * b) % P) if (e & 1n) r = (r * b) % P;
  return r;
};
const D = P - ((121665n * powMod(121666n, P - 2n)) % P);

/** Whether 32 bytes decode to an ed25519 point (RFC 8032 §5.1.3, y taken mod p as Solana does). */
function onCurve(b: Buffer): boolean {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(b[i]!);
  y = (y & ((1n << 255n) - 1n)) % P;
  const y2 = (y * y) % P;
  const u = (y2 + P - 1n) % P;
  const v = (D * y2 + 1n) % P;
  const v3 = (((v * v) % P) * v) % P;
  const x = (((u * v3) % P) * powMod((((u * v3) % P) * ((v3 * v) % P)) % P, (P - 5n) / 8n)) % P;
  const vx2 = (((v * x) % P) * x) % P;
  return vx2 === u || vx2 === (P - u) % P;
}

/** Solana's findProgramAddress: the first bump, from 255 down, whose hash is not a curve point. */
export function pda(seeds: Buffer[], program: string): string {
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash("sha256");
    for (const s of seeds) h.update(s);
    const k = h.update(Buffer.from([bump])).update(b58decode(program)).update("ProgramDerivedAddress").digest();
    if (!onCurve(k)) return b58encode(k);
  }
  throw new Error("no program address");
}

/** A pump token's bonding curve. */
export const curveOf = (mint: string): string => pda([Buffer.from("bonding-curve"), b58decode(mint)], PUMP_CURVE);

/** The PumpSwap pool a pump curve migrates into: index 0, made by pump's pool authority for the mint, against `quote`. */
export function migratedPool(mint: string, quote = WSOL): string {
  const authority = pda([Buffer.from("pool-authority"), b58decode(mint)], PUMP_CURVE);
  return pda([Buffer.from("pool"), Buffer.from([0, 0]), b58decode(authority), b58decode(mint), b58decode(quote)], PUMP_AMM);
}

/** An SPL token account's raw amount — the same offset in Token and Token-2022. */
export const tokenAmount = (d: Buffer): bigint => d.readBigUInt64LE(64);
/** An SPL mint's decimals. */
const mintDecimals = (d: Buffer): number => d[44]!;

// ── watches ───────────────────────────────────────────────────────────

/** `price` is quote per token, `liquidity` the quote reserve, both in whole units. */
export type Reading = { price: number; liquidity: number; quoteMint: string; slot: number; at: number };

type Watch = {
  mint: string;
  pool: string;
  state: "resolving" | "live" | "off";
  reason: string;
  retryAt: number;
  kind: "curve" | "amm";
  quoteMint: string;
  decimals: number[]; // [token, quote]
  accounts: string[]; // curve: [pool]; amm: [token vault, quote vault]
  seen: ({ amount: number; slot: number } | null)[];
  reading: Reading | null;
};

const watches = new Map<string, Watch>();
const byAccount = new Map<string, { w: Watch; i: number }>();

/** Fires "price" (detail: the mint) whenever a mint's price moves. */
export const feed = new EventTarget();

/** Starts watching `mint` in `pool`. A no-op while that pool is already watched; another pool replaces it. */
export function watch(mint: string, pool: string): Promise<void> {
  const had = watches.get(mint);
  if (had?.pool === pool) return Promise.resolve();
  if (had) unwatch(mint);
  const w: Watch = { mint, pool, state: "resolving", reason: "", retryAt: Infinity, kind: "curve", quoteMint: WSOL, decimals: [], accounts: [], seen: [], reading: null };
  watches.set(mint, w);
  return resolve(w);
}

export function unwatch(mint: string): void {
  const w = watches.get(mint);
  if (!w) return;
  unindex(w);
  watches.delete(mint);
}

export const watching = (): string[] => [...watches.keys()];

/** The last reading of a live watch, or null. */
export function reading(mint: string): Reading | null {
  const w = watches.get(mint);
  return w?.state === "live" ? w.reading : null;
}

/** Why a watched mint is not priced on-chain ("curve complete", "pool owned by …"), or null. */
export function offReason(mint: string): string | null {
  const w = watches.get(mint);
  return w?.state === "off" ? w.reason : null;
}

/** The quote tokens of every live watch: what the caller needs a USD price for. */
export const quoteMints = (): string[] => [...new Set([...watches.values()].filter((w) => w.state === "live").map((w) => w.quoteMint))];

export const socketUp = (): boolean => up;

/** Where a pool keeps `mint`'s reserves, with their contents as just read at `slot`. */
export type Resolved = { kind: "curve" | "amm"; quoteMint: string; decimals: number[]; accounts: string[]; slot: number; data: Buffer[] };

/** Reads a pool once and finds its reserve accounts, or says why it is not read on-chain. Network errors throw. */
export async function resolvePool(mint: string, pool: string): Promise<Resolved | string> {
  return (await resolvePools([{ mint, pool }]))[0]!;
}

/** Accounts by key, read 100 at a time; each keeps the slot of the read that brought it. */
async function many(keys: string[]): Promise<Map<string, { owner: string; data: Buffer; slot: number }>> {
  const out = new Map<string, { owner: string; data: Buffer; slot: number }>();
  for (let i = 0; i < keys.length; i += 100) {
    const r = await accounts(keys.slice(i, i + 100));
    r.list.forEach((a, j) => a && out.set(keys[i + j]!, { ...a, slot: r.slot }));
  }
  return out;
}

/**
 * `resolvePool` for many pools in two rounds of reads, whatever their number: every pool account,
 * then every mint and vault they name. Network errors throw.
 */
export async function resolvePools(items: { mint: string; pool: string }[]): Promise<(Resolved | string)[]> {
  const first = await many([...new Set(items.map((i) => i.pool))]);
  const plans = items.map(({ mint, pool }) => {
    const acc = first.get(pool);
    const layout = acc && decodePool(acc.owner, acc.data);
    if (!layout) return acc ? `pool owned by ${acc.owner.slice(0, 8)}…, not read on-chain` : "pool account not found";
    if (layout.kind === "curve") {
      const quoteMint = curveQuote(acc!.data);
      return { kind: "curve" as const, mint, quoteMint, accounts: [pool], first: acc! };
    }
    const tokenIsBase = layout.baseMint === mint;
    if (!tokenIsBase && layout.quoteMint !== mint) return "pool does not hold this token";
    const quoteMint = tokenIsBase ? layout.quoteMint : layout.baseMint;
    return { kind: "amm" as const, mint, quoteMint, accounts: tokenIsBase ? [layout.baseVault, layout.quoteVault] : [layout.quoteVault, layout.baseVault] };
  });
  const keys = plans.flatMap((p) => (typeof p === "string" ? [] : [p.mint, p.quoteMint, ...(p.kind === "amm" ? p.accounts : [])]));
  const second = await many([...new Set(keys.filter((k) => k !== WSOL))]);
  const decimalsOf = (m: string) => (m === WSOL ? 9 : second.has(m) ? mintDecimals(second.get(m)!.data) : null);
  return plans.map((p): Resolved | string => {
    if (typeof p === "string") return p;
    const decimals = [decimalsOf(p.mint), decimalsOf(p.quoteMint)];
    if (decimals[0] === null) return "mint account not found";
    if (decimals[1] === null) return "quote mint account not found";
    if (p.kind === "curve") return { kind: "curve", quoteMint: p.quoteMint, decimals: decimals as number[], accounts: p.accounts, slot: p.first.slot, data: [p.first.data] };
    const vaults = p.accounts.map((a) => second.get(a));
    if (vaults.some((v) => !v)) return "a pool account is missing";
    return { kind: "amm", quoteMint: p.quoteMint, decimals: decimals as number[], accounts: p.accounts, slot: vaults[0]!.slot, data: vaults.map((v) => v!.data) };
  });
}

/** Price (quote per token) and liquidity (the quote reserve) off one read of a pool's reserve accounts, all from one slot. */
export function poolReading(r: Pick<Resolved, "kind" | "decimals">, data: Buffer[]): { price: number; liquidity: number } | "complete" | null {
  if (r.kind === "curve") return curveReading(data[0]!, r.decimals[0]!, r.decimals[1]);
  const token = Number(tokenAmount(data[0]!)) / 10 ** r.decimals[0]!;
  const quote = Number(tokenAmount(data[1]!)) / 10 ** r.decimals[1]!;
  return token > 0 ? { price: quote / token, liquidity: quote } : null;
}

async function resolve(w: Watch): Promise<void> {
  try {
    const r = await resolvePool(w.mint, w.pool);
    if (typeof r === "string") return off(w, r);
    Object.assign(w, { kind: r.kind, quoteMint: r.quoteMint, decimals: r.decimals, accounts: r.accounts });
    if (watches.get(w.mint) !== w) return; // unwatched or replaced meanwhile
    w.state = "live";
    w.seen = w.accounts.map(() => null);
    w.accounts.forEach((acc, i) => {
      byAccount.set(acc, { w, i });
      subscribe(acc);
    });
    r.data.forEach((d, i) => apply(w, i, d, r.slot));
  } catch (e) {
    off(w, `pool read failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200), true);
  }
}

function off(w: Watch, reason: string, retry = false): void {
  unindex(w);
  w.state = "off";
  w.reason = reason;
  w.reading = null;
  w.retryAt = retry ? Date.now() + RETRY_MS : Infinity;
}

function unindex(w: Watch): void {
  for (const acc of w.accounts) {
    if (byAccount.get(acc)?.w !== w) continue;
    byAccount.delete(acc);
    const sub = subOf.get(acc);
    if (sub !== undefined) send("accountUnsubscribe", [sub]);
    subOf.delete(acc);
  }
}

/** One account's new contents at `slot`, from the socket or a poll. Older than what was seen: dropped. */
function apply(w: Watch, i: number, data: Buffer, slot: number): void {
  if (w.state !== "live" || (w.seen[i]?.slot ?? -1) > slot) return;
  if (w.kind === "curve") {
    const r = curveReading(data, w.decimals[0]!, w.decimals[1]);
    if (r === "complete") return off(w, "curve complete");
    w.seen[i] = { amount: 0, slot };
    if (r) commit(w, r.price, r.liquidity, slot);
    return;
  }
  w.seen[i] = { amount: Number(tokenAmount(data)) / 10 ** w.decimals[i]!, slot };
  const [token, quote] = w.seen;
  if (token && quote && token.slot === quote.slot && token.amount > 0) commit(w, quote.amount / token.amount, quote.amount, slot);
}

function commit(w: Watch, price: number, liquidity: number, slot: number): void {
  const moved = w.reading?.price !== price;
  w.reading = { price, liquidity, quoteMint: w.quoteMint, slot, at: Date.now() };
  if (moved) feed.dispatchEvent(new CustomEvent("price", { detail: w.mint }));
}

function onAccount(acc: string, data: Buffer, slot: number): void {
  const at = byAccount.get(acc);
  if (at) apply(at.w, at.i, data, slot);
}

/** One `getMultipleAccounts` read (at most 100 keys); a missing account is null. */
export async function accounts(keys: string[]): Promise<{ slot: number; list: ({ owner: string; data: Buffer } | null)[] }> {
  const r = await rpc("getMultipleAccounts", [keys, { encoding: "base64", commitment: COMMITMENT }]);
  const list = (r?.value ?? []).map((a: any) => (a?.data?.[0] !== undefined ? { owner: String(a.owner), data: Buffer.from(a.data[0], "base64") } : null));
  return { slot: Number(r?.context?.slot) || 0, list };
}

// ── socket ────────────────────────────────────────────────────────────

let ws: WebSocket | null = null;
let up = false;
let heardAt = 0;
let reconnectAt = 0;
let backoff = 1_000;
let nextId = 1;
const asked = new Map<number, string>(); // request id → account ("" = the slot heartbeat)
const subs = new Map<number, string>(); // subscription id → account
const subOf = new Map<string, number>(); // account → subscription id

/** SOLANA_WS_URL, else the RPC's own address over ws(s)://. */
const wsUrl = (): string => process.env.SOLANA_WS_URL?.trim() || rpcUrl().replace(/^http/, "ws");

function send(method: string, params: unknown[], acc?: string): void {
  if (!ws || !up) return;
  const id = nextId++;
  if (acc !== undefined) asked.set(id, acc);
  ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
}

function subscribe(acc: string): void {
  send("accountSubscribe", [acc, { encoding: "base64", commitment: COMMITMENT }], acc);
}

function connect(): void {
  const s = new WebSocket(wsUrl());
  ws = s;
  s.onopen = () => {
    if (ws !== s) return;
    up = true;
    heardAt = Date.now();
    backoff = 1_000;
    send("slotSubscribe", [], "");
    for (const acc of byAccount.keys()) subscribe(acc);
    pollAt = 0; // the socket reports changes from now on: read everything once
  };
  s.onmessage = (e) => {
    if (ws === s) heard(String(e.data));
  };
  s.onclose = () => {
    if (ws === s) drop();
  };
  s.onerror = () => {}; // a close follows
}

/** Forgets the socket; the next tick reconnects after the backoff. */
function drop(): void {
  const s = ws;
  ws = null;
  up = false;
  asked.clear();
  subs.clear();
  subOf.clear();
  try {
    s?.close();
  } catch {
    /* already closing */
  }
  reconnectAt = Date.now() + backoff;
  backoff = Math.min(backoff * 2, 30_000);
}

function heard(raw: string): void {
  heardAt = Date.now();
  let m: any;
  try {
    m = JSON.parse(raw);
  } catch {
    return;
  }
  if (m.id !== undefined) {
    const acc = asked.get(m.id);
    asked.delete(m.id);
    if (!acc || typeof m.result !== "number") return; // the heartbeat, an unsubscribe, or an error: the poll covers it
    if (!byAccount.has(acc)) return send("accountUnsubscribe", [m.result]); // unwatched while asking
    subs.set(m.result, acc);
    subOf.set(acc, m.result);
    return;
  }
  if (m.method !== "accountNotification") return; // slotNotification: liveness only
  const acc = subs.get(m.params?.subscription);
  const v = m.params?.result;
  if (acc && v?.value?.data?.[0] !== undefined) onAccount(acc, Buffer.from(v.value.data[0], "base64"), Number(v.context?.slot) || 0);
}

// ── tick ──────────────────────────────────────────────────────────────

let pollAt = 0;
let polling = false;

/** Keeps the socket and the backup poll going. Called every exit tick; returns at once. */
export function tick(now = Date.now()): void {
  for (const w of watches.values()) if (w.state === "off" && now >= w.retryAt) void resolve(Object.assign(w, { state: "resolving", retryAt: Infinity }));
  if (!byAccount.size) {
    if (ws) drop();
    backoff = 1_000;
    reconnectAt = 0;
    return;
  }
  if (!ws && now >= reconnectAt) connect();
  else if (up && now - heardAt > SILENT_MS) drop();
  if (!polling && now - pollAt >= (up ? RESYNC_MS : DOWN_POLL_MS)) void poll(now);
}

async function poll(now: number): Promise<void> {
  polling = true;
  pollAt = now;
  try {
    const keys = [...byAccount.keys()];
    for (let i = 0; i < keys.length; i += 100) {
      const r = await accounts(keys.slice(i, i + 100));
      r.list.forEach((a, j) => a && onAccount(keys[i + j]!, a.data, r.slot));
    }
  } catch {
    // the next poll tries again; pushes keep coming if the socket is up
  } finally {
    polling = false;
  }
}
