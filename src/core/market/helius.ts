/**
 * Real-time prices straight off the chain, over Helius' standard Solana websocket — the cast
 * boundary for it, as `gmgn.ts` is for GMGN. The monitor's GMGN read every tick stays underneath as the
 * fallback: this file only ever makes a price arrive sooner, and says nothing when it cannot.
 *
 * The websocket carries account changes, not prices, so a price is derived from the pool:
 * subscribe to its two vaults and divide. Only one pool shape is read — a pump.fun AMM
 * (`pump_amm`) pool quoted in SOL — because every shape needs its own arithmetic, and this is
 * the one nearly every candidate here trades on. `poolRef` returns null for anything else.
 *
 * `HELIUS_API_KEY` turns it on. `HELIUS_URL` (host and path, no scheme) points both the
 * websocket and the one HTTP read at another Solana RPC — the public one works, slowly.
 */

const WSOL = "So11111111111111111111111111111111111111112";

/**
 * A pump_amm pool does not price off its vault balances alone: the pool account carries a
 * virtual quote reserve (~17.6 SOL, lamports as a u64) that is added to the SOL side. This offset
 * is not from a published layout — it was read off live pools, where vault ratio + this field
 * matched GMGN's price and the bare ratio ran 10-74% under it. The monitor therefore does not
 * act on a stream until it has agreed with a GMGN read once.
 */
const VIRTUAL_QUOTE_AT = 245;

export type PoolRef = { pool: string; baseVault: string; quoteVault: string };

/** The pool a token's price can be streamed from, out of a GMGN `token/info` row — or null. */
export function poolRef(info: Record<string, any> | null): PoolRef | null {
  const p = info?.["pool"];
  if (p?.exchange !== "pump_amm" || p.quote_address !== WSOL) return null;
  if (!p.pool_address || !p.base_vault_address || !p.quote_vault_address) return null;
  return { pool: p.pool_address, baseVault: p.base_vault_address, quoteVault: p.quote_vault_address };
}

/** The virtual quote reserve in SOL, out of a pool account's base64 data. Null when it is too short to hold one. */
export function virtualQuote(dataB64: unknown): number | null {
  if (typeof dataB64 !== "string") return null;
  const d = Buffer.from(dataB64, "base64");
  return d.length >= VIRTUAL_QUOTE_AT + 8 ? Number(d.readBigUInt64LE(VIRTUAL_QUOTE_AT)) / 1e9 : null;
}

/** SOL per token. Both reserves in whole units. */
export const poolPrice = (base: number, quote: number, virtual: number): number => (base > 0 ? (quote + virtual) / base : 0);

const host = (): string => {
  const key = process.env.HELIUS_API_KEY?.trim();
  return process.env.HELIUS_URL?.trim() || (key ? `mainnet.helius-rpc.com/?api-key=${key}` : "");
};

export const enabled = (): boolean => !!host();

type Kind = "base" | "quote" | "pool";
type Reading = { slot: number; amount: number };
type Feed = PoolRef & { onPrice: (sol: number) => void; base?: Reading; quote?: Reading; virtual?: number };

const feeds = new Map<string, Feed>(); // by mint
const pending = new Map<number, [mint: string, kind: Kind]>(); // request id, until the server names the subscription
const subs = new Map<number, [mint: string, kind: Kind]>(); // subscription id
let ws: WebSocket | null = null;
let nextId = 1;

function subscribe(mint: string, f: Feed): void {
  for (const [kind, account] of [["base", f.baseVault], ["quote", f.quoteVault], ["pool", f.pool]] as const) {
    const id = nextId++;
    pending.set(id, [mint, kind]);
    ws!.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "accountSubscribe",
        params: [account, { encoding: kind === "pool" ? "base64" : "jsonParsed", commitment: "confirmed" }],
      }),
    );
  }
}

function onMessage(raw: string): void {
  let m: Record<string, any>;
  try {
    m = JSON.parse(raw);
  } catch {
    return;
  }
  if (m["id"] != null) {
    const p = pending.get(m["id"]);
    pending.delete(m["id"]);
    if (p && typeof m["result"] === "number") subs.set(m["result"], p);
    return;
  }
  const hit = subs.get(m["params"]?.subscription);
  const f = hit && feeds.get(hit[0]);
  if (!hit || !f) return;
  const r = m["params"].result;
  if (hit[1] === "pool") {
    const v = virtualQuote(r?.value?.data?.[0]);
    if (v != null) f.virtual = v;
    return;
  }
  const amount = Number(r?.value?.data?.parsed?.info?.tokenAmount?.uiAmount);
  if (!(amount >= 0)) return;
  f[hit[1]] = { slot: Number(r?.context?.slot), amount };
  // A swap moves both vaults, and they arrive as two messages. Between them one side is new and
  // the other old — a price that never existed. Only a pair from the same slot is a price.
  if (f.virtual == null || !f.base || !f.quote || f.base.slot !== f.quote.slot) return;
  const price = poolPrice(f.base.amount, f.quote.amount, f.virtual);
  if (price > 0) f.onPrice(price);
}

// ponytail: a socket that dies without a close event is not noticed here — the monitor's per-tick
// GMGN read takes over once the stream goes quiet. Add a heartbeat if that ever costs an exit.
function connect(): void {
  if (ws || !feeds.size) return;
  const sock = (ws = new WebSocket(`wss://${host()}`));
  sock.onopen = () => {
    for (const [mint, f] of feeds) subscribe(mint, f);
  };
  sock.onmessage = (ev) => onMessage(String(ev.data));
  sock.onerror = () => {}; // a close always follows, and that is where it is handled
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    pending.clear();
    subs.clear();
    // Half a pair from before the gap must not meet half a pair from after it.
    for (const f of feeds.values()) f.base = f.quote = undefined;
    if (feeds.size) setTimeout(connect, 2000);
  };
}

/** The pool account only changes when the pool itself does, so its current state is read once. */
async function readVirtual(pool: string): Promise<number | null> {
  const res = await fetch(`https://${host()}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [pool, { encoding: "base64", commitment: "confirmed" }] }),
    signal: AbortSignal.timeout(15_000),
  });
  return virtualQuote(((await res.json()) as Record<string, any>)["result"]?.value?.data?.[0]);
}

/**
 * Streams one token's price: `onPrice` gets SOL per token on every swap in its pool. Nothing
 * arrives until the first swap after subscribing, and nothing at all if the pool account cannot
 * be read — the caller keeps its own price until then.
 */
export function watch(mint: string, ref: PoolRef, onPrice: (sol: number) => void): void {
  if (!enabled() || feeds.has(mint)) return;
  const f: Feed = { ...ref, onPrice };
  feeds.set(mint, f);
  void readVirtual(ref.pool)
    .then((v) => {
      if (v != null) f.virtual ??= v;
    })
    .catch(() => {});
  if (ws?.readyState === WebSocket.OPEN) subscribe(mint, f);
  else connect();
}

export function unwatch(mint: string): void {
  if (!feeds.delete(mint)) return;
  for (const [id, [m]] of subs) {
    if (m !== mint) continue;
    subs.delete(id);
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "accountUnsubscribe", params: [id] }));
  }
  if (!feeds.size && ws) {
    const sock = ws;
    ws = null; // so its close handler does not reconnect
    sock.close();
  }
}
