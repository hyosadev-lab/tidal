import { b58encode, rpc, rpcUrl, WSOL } from "./client.ts";

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

/** A bonding curve's price (SOL per token) and liquidity (real SOL), or "complete" once it has migrated. */
export function curveReading(d: Buffer, decimals: number): { price: number; liquidity: number } | "complete" | null {
  if (d[48]) return "complete";
  const tokens = Number(d.readBigUInt64LE(8)) / 10 ** decimals; // virtual token reserves
  const sol = Number(d.readBigUInt64LE(16)) / 1e9; // virtual SOL reserves
  return tokens > 0 ? { price: sol / tokens, liquidity: Number(d.readBigUInt64LE(32)) / 1e9 } : null;
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
  decimals: number[]; // curve: [token]; amm: [token, quote]
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

async function resolve(w: Watch): Promise<void> {
  try {
    let first = await accounts([w.pool]);
    const pool = first.list[0];
    const layout = pool && decodePool(pool.owner, pool.data);
    if (!layout) return off(w, pool ? `pool owned by ${pool.owner.slice(0, 8)}…, not read on-chain` : "pool account not found");
    if (layout.kind === "curve") {
      const mint = (await accounts([w.mint])).list[0];
      if (!mint) return off(w, "mint account not found");
      Object.assign(w, { kind: "curve", quoteMint: WSOL, decimals: [mintDecimals(mint.data)], accounts: [w.pool] });
    } else {
      const tokenIsBase = layout.baseMint === w.mint;
      if (!tokenIsBase && layout.quoteMint !== w.mint) return off(w, "pool does not hold this token");
      const other = tokenIsBase ? layout.quoteMint : layout.baseMint;
      const vaults = tokenIsBase ? [layout.baseVault, layout.quoteVault] : [layout.quoteVault, layout.baseVault];
      const r = await accounts([w.mint, other, ...vaults]);
      if (r.list.some((a) => !a)) return off(w, "a pool account is missing");
      Object.assign(w, { kind: "amm", quoteMint: other, decimals: [mintDecimals(r.list[0]!.data), mintDecimals(r.list[1]!.data)], accounts: vaults });
      first = { slot: r.slot, list: r.list.slice(2) };
    }
    if (watches.get(w.mint) !== w) return; // unwatched or replaced meanwhile
    w.state = "live";
    w.seen = w.accounts.map(() => null);
    w.accounts.forEach((acc, i) => {
      byAccount.set(acc, { w, i });
      subscribe(acc);
    });
    first.list.forEach((a, i) => a && apply(w, i, a.data, first.slot));
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
    const r = curveReading(data, w.decimals[0]!);
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

async function accounts(keys: string[]): Promise<{ slot: number; list: ({ owner: string; data: Buffer } | null)[] }> {
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
