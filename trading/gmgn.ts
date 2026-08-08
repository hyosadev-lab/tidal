import { constants, createPrivateKey, randomUUID, sign as cryptoSign } from "node:crypto";
import type { Chain } from "./types.ts";

/**
 * Thin client for the GMGN OpenAPI. Every call goes through a shared leaky bucket
 * (rate 20, capacity 20, per-route weights) because GMGN extends the cooldown by
 * 5s each time you hit a 429 — spamming retries makes the ban worse, not better.
 *
 * Two auth modes, matching the server:
 *   exist  — X-APIKEY + timestamp + client_id. Every read route.
 *   signed — the above plus X-Signature over the request. Only swap and query_order.
 *
 * GMGN_PRIVATE_KEY is a request-signing key for this API, not a wallet key, but it is
 * still spend authority: it is only ever read on the two signed routes below.
 */

const HOST = "https://openapi.gmgn.ai";

const RATE = 20;
const CAPACITY = 20;
let tokens = CAPACITY;
let lastRefill = Date.now();
let queue: Promise<unknown> = Promise.resolve();

async function takeTokens(weight: number): Promise<void> {
  for (;;) {
    const now = Date.now();
    tokens = Math.min(CAPACITY, tokens + ((now - lastRefill) / 1000) * RATE);
    lastRefill = now;
    if (tokens >= weight) {
      tokens -= weight;
      return;
    }
    await new Promise((r) => setTimeout(r, Math.ceil(((weight - tokens) / RATE) * 1000) + 20));
  }
}

export class GmgnError extends Error {
  code: number;
  resetAt: number;
  constructor(message: string, code = 0, resetAt = 0) {
    super(message);
    this.name = "GmgnError";
    this.code = code;
    this.resetAt = resetAt;
  }
}

type Query = Record<string, string | number | string[]>;

function apiKey(): string {
  const k = process.env.GMGN_API_KEY?.trim();
  if (!k) throw new GmgnError("GMGN_API_KEY is missing — set it in .env");
  return k;
}

/**
 * The string the server verifies: `{path}:{sorted query}:{body}:{timestamp}`. Keys sorted
 * alphabetically, array values sorted by value, encoded exactly as they go on the wire.
 * Any drift here and every trade request is rejected — hence the test.
 */
export function signedMessage(path: string, query: Query, body: string, timestamp: number): string {
  const qs = Object.keys(query)
    .sort()
    .flatMap((k) => {
      const ek = encodeURIComponent(k);
      const v = query[k];
      return Array.isArray(v)
        ? [...v].sort().map((i) => `${ek}=${encodeURIComponent(i)}`)
        : [`${ek}=${encodeURIComponent(String(v))}`];
    })
    .join("&");
  return `${path}:${qs}:${body}:${timestamp}`;
}

/** Ed25519 signs the raw message; RSA uses PSS/SHA-256 with a 32-byte salt. */
export function signMessage(message: string, pem: string): string {
  const msg = Buffer.from(message, "utf8");
  const kind = createPrivateKey(pem).asymmetricKeyType;
  if (kind === "ed25519") return cryptoSign(null, msg, pem).toString("base64");
  if (kind === "rsa")
    return cryptoSign("sha256", msg, {
      key: pem,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32,
    }).toString("base64");
  throw new GmgnError(`unsupported GMGN_PRIVATE_KEY type: ${kind} (need Ed25519 or RSA)`);
}

function signature(path: string, query: Query, body: string, timestamp: number): string {
  const pem = process.env.GMGN_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();
  if (!pem) throw new GmgnError("GMGN_PRIVATE_KEY is missing — required to sign trade requests");
  return signMessage(signedMessage(path, query, body, timestamp), pem);
}

type ApiOpts = { weight?: number; timeoutMs?: number; signed?: boolean };

/** Serialised so the bucket accounting stays honest under concurrency. */
async function api<T = any>(
  method: "GET" | "POST",
  path: string,
  query: Query = {},
  body: unknown = null,
  { weight = 1, timeoutMs = 60_000, signed = false }: ApiOpts = {},
): Promise<T> {
  const run = async (): Promise<T> => {
    await takeTokens(weight);

    // timestamp is validated within ±5s and client_id replay-checked, so both are
    // built here rather than at call time — a queued request may wait a while.
    const q: Query = { ...query, timestamp: Math.floor(Date.now() / 1000), client_id: randomUUID() };
    const bodyStr = body !== null ? JSON.stringify(body) : signed ? "" : null;

    const headers: Record<string, string> = { "X-APIKEY": apiKey(), "Content-Type": "application/json" };
    if (signed) headers["X-Signature"] = signature(path, q, bodyStr ?? "", Number(q["timestamp"]));

    const url = new URL(HOST + path);
    for (const [k, v] of Object.entries(q)) {
      if (Array.isArray(v)) for (const i of v) url.searchParams.append(k, i);
      else url.searchParams.append(k, String(v));
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: bodyStr || undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new GmgnError(`${method} ${path} failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    const resetAt = Number(res.headers.get("x-ratelimit-reset")) || 0;
    const text = await res.text();
    let env: { code?: number | string; data?: unknown; message?: string; error?: string };
    try {
      env = JSON.parse(text);
    } catch {
      throw new GmgnError(`${method} ${path}: HTTP ${res.status}, non-JSON body: ${text.slice(0, 300)}`, res.status, resetAt);
    }

    if (!res.ok || (env.code !== 0 && env.code !== undefined)) {
      const msg = env.error || env.message || text.slice(0, 300);
      throw new GmgnError(`${method} ${path}: ${msg}`.slice(0, 1200), res.status === 429 ? 429 : res.status || 1, resetAt);
    }
    return (env.data ?? env) as T;
  };
  const result = queue.then(run, run);
  queue = result.catch(() => undefined);
  return result;
}

export const num = (v: unknown, d = 0): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : d;
};

const list = (r: any, ...keys: string[]): any[] => {
  if (Array.isArray(r)) return r;
  for (const k of keys) if (Array.isArray(r?.[k])) return r[k];
  for (const k of keys) if (Array.isArray(r?.data?.[k])) return r.data[k];
  return [];
};

// ── read-only routes ──────────────────────────────────────────────────

/** Cheapest authenticated route — proves the API key works. */
export async function apiReady(): Promise<boolean> {
  try {
    await api("GET", "/v1/user/info", {}, null, { timeoutMs: 20_000 });
    return true;
  } catch {
    return false;
  }
}

export type RankItem = Record<string, any>;

export async function trending(
  chain: Chain,
  opts: {
    interval?: string;
    limit?: number;
    minLiquidity?: number;
    minVolume?: number;
    maxRugRatio?: number;
    minSmartDegen?: number;
    maxCreated?: string;
    minCreated?: string;
    minRenowned?: number;
    maxTop10Rate?: number;
    orderBy?: string;
    platforms?: string[];
    /** Operator's Refine rows, already mapped to rank params by `refineQuery`. */
    refine?: Record<string, string | number>;
  } = {},
): Promise<RankItem[]> {
  const q: Query = {
    chain,
    interval: opts.interval ?? "1h",
    order_by: opts.orderBy ?? "volume",
    limit: opts.limit ?? 50,
  };
  if (opts.minLiquidity) q["min_liquidity"] = Math.round(opts.minLiquidity);
  if (opts.minVolume) q["min_volume"] = Math.round(opts.minVolume);
  if (opts.minSmartDegen) q["min_smart_degen_count"] = opts.minSmartDegen;
  if (opts.minRenowned) q["min_renowned_count"] = opts.minRenowned;
  if (opts.maxTop10Rate) q["max_top10_holder_rate"] = opts.maxTop10Rate;
  if (opts.maxCreated) q["max_created"] = opts.maxCreated;
  if (opts.minCreated) q["min_created"] = opts.minCreated;
  if (opts.platforms?.length) q["platforms"] = opts.platforms;
  // Last word to the operator: a Refine row overrides the caller's floor for the same param.
  // Only the query moves — `runGates` still disqualifies whatever comes back below SKIP.
  Object.assign(q, opts.refine);
  return list(await api("GET", "/v1/market/rank", q), "rank");
}

/**
 * Most-searched tokens on GMGN. A crowd-attention feed, not a quality signal.
 * The response nests the real rows one level down, per requested chain/interval.
 */
export async function hotSearches(chain: Chain, interval = "1h", limit = 30): Promise<RankItem[]> {
  const r = await api("POST", "/v1/market/hot_searches", {}, { params: [{ chain, interval, limit }] }, { weight: 2 });
  return list(r, "list", "rank").flatMap((g: any) => list(g, "tokens"));
}

/** Mirrors the CLI's `--filter-preset strict`. */
const TRENCHES_STRICT = {
  max_rug_ratio: 0.3,
  max_bundler_rate: 0.3,
  max_insider_ratio: 0.3,
  min_smart_degen_count: 1,
  min_volume_24h: 1000,
};

/**
 * The operator's Refine rows over the strict preset. Where both name the same field, the
 * tighter of the two wins: the dashboard can narrow this feed, never loosen it past strict.
 */
export function trenchesFilters(refine: Record<string, string | number> = {}): Record<string, string | number> {
  const out = { ...TRENCHES_STRICT, ...refine } as Record<string, string | number>;
  for (const [k, preset] of Object.entries(TRENCHES_STRICT))
    out[k] = k.startsWith("max_") ? Math.min(preset, num(out[k], preset)) : Math.max(preset, num(out[k], preset));
  return out;
}

// launchpad_platform and quote_address_type are allow-lists: sending an empty array
// filters everything out, so a chain we have no list for omits the field and takes the
// server default. ponytail: only the two chains gatherCandidates calls trenches for —
// add base/eth here when a caller needs them.
const TRENCHES_PLATFORMS: Partial<Record<Chain, string[]>> = {
  sol: [
    "Pump.fun", "pump_mayhem", "pump_mayhem_agent", "pump_agent", "letsbonk", "bonkers",
    "bags", "memoo", "liquid", "bankr", "zora", "surge", "anoncoin", "moonshot_app",
    "wendotdev", "heaven", "sugar", "token_mill", "believe", "trendsfun", "trends_fun",
    "jup_studio", "Moonshot", "boop", "ray_launchpad", "meteora_virtual_curve", "xstocks",
  ],
  bsc: [
    "fourmeme", "fourmeme_agent", "bn_fourmeme", "four_xmode_agent", "cubepeg", "likwid",
    "goplus_creator", "goplus_skills", "openfour", "flap", "flap_stocks", "flap_aioracle",
    "clanker", "lunafun",
  ],
};
const TRENCHES_QUOTE_TYPES: Partial<Record<Chain, number[]>> = {
  sol: [4, 5, 3, 1, 13, 0],
  bsc: [6, 7, 1, 16, 8, 3, 9, 10, 2, 17, 18, 0],
};

export type TrenchType = "completed" | "near_completion" | "new_creation";

export async function trenches(
  chain: Chain,
  type: TrenchType | string = "completed",
  limit = 40,
  refine?: Record<string, string | number>,
): Promise<RankItem[]> {
  const section: Record<string, unknown> = {
    filters: ["offchain", "onchain"],
    launchpad_platform_v2: true,
    limit,
    ...trenchesFilters(refine),
  };
  const platforms = TRENCHES_PLATFORMS[chain];
  const quoteTypes = TRENCHES_QUOTE_TYPES[chain];
  if (platforms?.length) section["launchpad_platform"] = platforms;
  if (quoteTypes?.length) section["quote_address_type"] = quoteTypes;

  const r = await api("POST", "/v1/trenches", { chain }, { version: "v2", [type]: section }, { weight: 3 });
  return [...list(r, "completed"), ...list(r, "near_completion"), ...list(r, "pump"), ...list(r, "new_creation")];
}

/**
 * Signal types: 12 = smart money buy, 6 = price spike, 7 = ATH.
 * Each row wraps the token payload in `data`; unwrap it so callers see one row shape.
 */
export async function signals(chain: Chain, signalTypes?: number[]): Promise<RankItem[]> {
  const groups = signalTypes?.length ? [{ signal_type: signalTypes }] : [{ signal_type: [12] }, { signal_type: [6, 7] }];
  const r = await api("POST", "/v1/market/token_signal", {}, { chain, groups }, { weight: 3 });
  return list(r, "list", "signals").map((s: any) => ({ ...(s.data ?? {}), signal_type: s.signal_type, trigger_mc: s.trigger_mc }));
}

export async function tokenInfo(chain: Chain, address: string): Promise<Record<string, any>> {
  return api("GET", "/v1/token/info", { chain, address }, null, { timeoutMs: 40_000 });
}

export async function tokenSecurity(chain: Chain, address: string): Promise<Record<string, any>> {
  return api("GET", "/v1/token/security", { chain, address }, null, { timeoutMs: 40_000 });
}

export async function tokenHolders(chain: Chain, address: string, limit = 20, tag?: string): Promise<any[]> {
  const q: Query = { chain, address, limit, order_by: "amount_percentage", direction: "desc" };
  if (tag) q["tag"] = tag;
  return list(await api("GET", "/v1/market/token_top_holders", q, null, { weight: 5 }), "list");
}

export async function kline(chain: Chain, address: string, resolution: string, fromSec: number, toSec: number) {
  // The API takes milliseconds here; every other timestamp in this file is seconds.
  const q: Query = {
    chain,
    address,
    resolution,
    from: Math.floor(fromSec) * 1000,
    to: Math.floor(toSec) * 1000,
  };
  return list(await api("GET", "/v1/market/token_kline", q, null, { weight: 2 }), "list");
}

export async function smartMoney(chain: Chain, limit = 60): Promise<any[]> {
  return list(await api("GET", "/v1/user/smartmoney", { chain, limit }), "list");
}

export async function nativeUsdPrice(chain: Chain): Promise<number> {
  const r = await api("GET", "/v1/trade/gas_price", { chain }, null, { timeoutMs: 30_000 });
  return num(r?.native_token_usd_price ?? r?.nativeTokenUsdPrice);
}

/**
 * Native balance of the API-key-bound wallet, in whole units (SOL / BNB / ETH).
 *
 * `/v1/user/info` returns the key's wallets and their main-currency balances, but the
 * field names are not documented, so this walks the response looking for the matching
 * wallet and a balance-shaped number. Returns null rather than a guess — sizing a real
 * trade off an invented balance is worse than not trading.
 */
export async function nativeBalance(chain: Chain, wallet: string): Promise<number | null> {
  const r = await api("GET", "/v1/user/info", {}, null, { timeoutMs: 40_000 });
  const target = wallet.trim().toLowerCase();

  const balanceOf = (o: Record<string, any>): number | null => {
    for (const k of ["balance", "native_balance", "sol_balance", "amount", "available_balance"]) {
      const v = num(o[k], -1);
      if (v >= 0) return v;
    }
    return null;
  };

  const walk = (node: unknown, depth = 0): number | null => {
    if (depth > 5 || !node || typeof node !== "object") return null;
    if (Array.isArray(node)) {
      for (const item of node) {
        const hit = walk(item, depth + 1);
        if (hit !== null) return hit;
      }
      return null;
    }
    const o = node as Record<string, any>;
    const addr = String(o.address ?? o.wallet ?? o.wallet_address ?? "").toLowerCase();
    const nodeChain = String(o.chain ?? "").toLowerCase();
    if (addr === target && (!nodeChain || nodeChain === chain)) {
      const b = balanceOf(o);
      if (b !== null) return b;
    }
    for (const v of Object.values(o)) {
      const hit = walk(v, depth + 1);
      if (hit !== null) return hit;
    }
    return null;
  };

  return walk(r);
}

/** Live price for a held position. Falls back to the pool price if info is thin. */
export async function currentPrice(chain: Chain, address: string): Promise<number> {
  const info = await tokenInfo(chain, address);
  const p = num(info?.price?.price ?? info?.price);
  if (p > 0) return p;
  const pool = await api<Record<string, any>>("GET", "/v1/token/pool_info", { chain, address }, null, { timeoutMs: 30_000 });
  return num(pool?.price ?? pool?.[0]?.price);
}

// ── execution routes ──────────────────────────────────────────────────

export type SwapResult = {
  order_id?: string;
  hash?: string;
  status?: string;
  error_code?: string;
  error_status?: string;
  strategy_order_id?: string;
  report?: Record<string, any>;
};

export type SwapArgs = {
  chain: Chain;
  from: string;
  inputToken: string;
  outputToken: string;
  /** Smallest-unit amount. Mutually exclusive with percent. */
  amount?: string;
  /** Percent of balance — only valid when the input token is NOT a currency. */
  percent?: number;
  slippage: number;
  antiMev?: boolean;
  conditionOrders?: unknown[];
  sellRatioType?: "buy_amount" | "hold_amount";
};

/** Wallets are case-sensitive on Solana and lowercased everywhere else. */
const fromAddress = (chain: Chain, from: string) => (chain === "sol" ? from : from.toLowerCase());

export async function quote(a: Omit<SwapArgs, "conditionOrders" | "sellRatioType">): Promise<Record<string, any>> {
  const q: Query = {
    chain: a.chain,
    from_address: fromAddress(a.chain, a.from),
    input_token: a.inputToken,
    output_token: a.outputToken,
    input_amount: a.amount ?? "0",
    slippage: a.slippage,
  };
  return api("GET", "/v1/trade/quote", q, null, { weight: 2, timeoutMs: 45_000 });
}

/**
 * Submits a real, irreversible on-chain swap.
 *
 * This process now signs trade requests itself, so this check is the only thing standing
 * between a bug — or a token name the analyst was talked into trusting — and real money.
 * GMGN_ALLOW_AUTOMATED_TRADES is the operator's standing consent to headless execution:
 * read it, never write it, and do not add a config knob that can substitute for it.
 */
export async function swap(a: SwapArgs): Promise<SwapResult> {
  if (process.env.GMGN_ALLOW_AUTOMATED_TRADES !== "1")
    throw new GmgnError("live trade refused: GMGN_ALLOW_AUTOMATED_TRADES=1 is not set in this shell");

  const body: Record<string, unknown> = {
    chain: a.chain,
    from_address: fromAddress(a.chain, a.from),
    input_token: a.inputToken,
    output_token: a.outputToken,
    // With a percent sell the amount field is a placeholder; bps carries the real size.
    input_amount: a.percent != null ? (a.amount ?? "0") : a.amount,
    slippage: a.slippage,
  };
  if (a.percent != null) body["input_amount_bps"] = String(Math.round(a.percent * 100));
  if (a.antiMev && a.chain !== "base") body["is_anti_mev"] = true;
  if (a.conditionOrders?.length) {
    body["condition_orders"] = a.conditionOrders;
    body["sell_ratio_type"] = a.sellRatioType ?? "hold_amount";
  }
  return api<SwapResult>("POST", "/v1/trade/swap", {}, body, { weight: 5, timeoutMs: 120_000, signed: true });
}

export async function orderStatus(chain: Chain, orderId: string): Promise<SwapResult> {
  return api<SwapResult>("GET", "/v1/trade/query_order", { chain, order_id: orderId }, null, {
    timeoutMs: 30_000,
    signed: true,
  });
}

/** Polls until the order settles; GMGN moves pending → processed → confirmed. */
export async function waitForOrder(chain: Chain, orderId: string, tries = 6): Promise<SwapResult> {
  let last: SwapResult = {};
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    try {
      last = await orderStatus(chain, orderId);
      const s = (last.status ?? "").toLowerCase();
      if (["confirmed", "successful", "failed", "expired"].includes(s)) return last;
    } catch {
      /* keep polling; a transient read failure is not a failed trade */
    }
  }
  return last;
}
