import { gmgnClient } from "../../gmgn/client.ts";
import type { SwapParams } from "../../gmgn/endpoint.ts";
import { NATIVE, num, PRIORITY_FEE, TIP_FEE } from "../core/config.ts";
import type { Chain } from "../core/types.ts";

/**
 * The market layer: what the trading engine asks the GMGN API, in the engine's own
 * vocabulary. Transport lives in `../gmgn/` — auth, signing, the leaky bucket, retries —
 * and this file never speaks HTTP.
 *
 * It is also the cast boundary. `OpenApiClient` returns `unknown` and GMGN's envelopes
 * nest their rows differently per route; everything above this file (plan, broker,
 * engine) sees one row shape and never touches `gmgnClient()` directly.
 */

const client = () => gmgnClient();

/** Rows arrive at the top level, under a named key, or under `data.<key>` depending on the route. */
const list = (r: any, ...keys: string[]): any[] => {
  if (Array.isArray(r)) return r;
  for (const k of keys) if (Array.isArray(r?.[k])) return r[k];
  for (const k of keys) if (Array.isArray(r?.data?.[k])) return r.data[k];
  return [];
};

const obj = (r: unknown): Record<string, any> => (r && typeof r === "object" ? (r as Record<string, any>) : {});

// ── read-only routes ──────────────────────────────────────────────────

/** Cheapest authenticated route — proves the API key works. */
export async function apiReady(): Promise<boolean> {
  try {
    await client().getUserInfo();
    return true;
  } catch {
    return false;
  }
}

export type RankItem = Record<string, any>;

/**
 * The rank feed. Every filter param GMGN accepts here now comes from one place — the operator's
 * Refine rows — so this takes no floors of its own; see `REFINE_FIELDS` (config.ts) for the
 * mapping. Only the query moves: what comes back is scored, never gated on these.
 */
export async function trending(
  chain: Chain,
  opts: {
    interval?: string;
    limit?: number;
    /** Operator's Refine rows, already mapped to rank params by `refineQuery`. */
    refine?: Record<string, string | number>;
  } = {},
): Promise<RankItem[]> {
  const q: Record<string, string | number> = {
    order_by: "volume",
    limit: opts.limit ?? 50,
    ...opts.refine,
  };
  return list(await client().getTrendingSwaps(chain, opts.interval ?? "1h", q), "rank");
}

/**
 * Most-searched tokens on GMGN. A crowd-attention feed, not a quality signal.
 * The response nests the real rows one level down, per requested chain/interval.
 */
export async function hotSearches(chain: Chain, interval = "1h", limit = 30): Promise<RankItem[]> {
  const r = await client().getHotSearches([{ chain, interval, limit }]);
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

export type TrenchType = "completed" | "near_completion" | "new_creation";

/**
 * One launchpad section at a time. The platform and quote-address allow-lists live in the
 * client's own per-chain tables — passing platforms here would override them, and an empty
 * override filters every result out.
 */
export async function trenches(
  chain: Chain,
  type: TrenchType | string = "completed",
  limit = 40,
  refine?: Record<string, string | number>,
): Promise<RankItem[]> {
  const r = await client().getTrenches(chain, [type], undefined, limit, trenchesFilters(refine));
  return [...list(r, "completed"), ...list(r, "near_completion"), ...list(r, "pump"), ...list(r, "new_creation")];
}

/**
 * Signal types: 12 = smart money buy, 6 = price spike, 7 = ATH.
 * Each row wraps the token payload in `data`; unwrap it so callers see one row shape.
 */
export async function signals(chain: Chain, signalTypes?: number[]): Promise<RankItem[]> {
  const groups = signalTypes?.length ? [{ signal_type: signalTypes }] : [{ signal_type: [12] }, { signal_type: [6, 7] }];
  const r = await client().getTokenSignalV2(chain, groups);
  return list(r, "list", "signals").map((s: any) => ({ ...(s.data ?? {}), signal_type: s.signal_type, trigger_mc: s.trigger_mc }));
}

export async function tokenInfo(chain: Chain, address: string): Promise<Record<string, any>> {
  return obj(await client().getTokenInfo(chain, address));
}

export async function tokenSecurity(chain: Chain, address: string): Promise<Record<string, any>> {
  return obj(await client().getTokenSecurity(chain, address));
}

export async function tokenHolders(chain: Chain, address: string, limit = 20, tag?: string): Promise<any[]> {
  const extra: Record<string, string | number> = { limit, order_by: "amount_percentage", direction: "desc" };
  if (tag) extra["tag"] = tag;
  return list(await client().getTokenTopHolders(chain, address, extra), "list");
}

export async function kline(chain: Chain, address: string, resolution: string, fromSec: number, toSec: number) {
  // The API takes milliseconds here; every other timestamp in this file is seconds.
  const r = await client().getTokenKline(chain, address, resolution, Math.floor(fromSec) * 1000, Math.floor(toSec) * 1000);
  return list(r, "list");
}

export async function smartMoney(chain: Chain, limit = 60): Promise<any[]> {
  return list(await client().getSmartMoney(chain, limit), "list");
}

export type GasQuote = {
  nativeUsd: number;
  /** Network-suggested priority fee, native units. 0 when the route did not carry one. */
  priorityFee: number;
  /** Suggested MEV-relay tip, native units. 0 when the route did not carry one. */
  tipFee: number;
};

/**
 * Native price *and* what the chain currently costs to get into a block, from one call.
 *
 * `/v1/chain/gas_price` already answers both — `auto` is the fee GMGN's own client would pick
 * and `auto_mev` the tip the protected relay wants — so a buy pays for this read anyway. Only
 * Solana's numbers are read here: on EVM the same fields are gas prices in the chain's own
 * units, which is not what `priority_fee` / `tip_fee` take. Those chains keep the constants.
 */
export async function gasQuote(chain: Chain): Promise<GasQuote> {
  if (gasCache && gasCache.chain === chain && Date.now() - gasCache.at < 30_000) return gasCache.q;
  const r = obj(await client().getGasPrice(chain));
  const nativeUsd = num(r["native_token_usd_price"] ?? r["nativeTokenUsdPrice"]);
  const q: GasQuote =
    chain === "sol"
      ? { nativeUsd, priorityFee: num(r["auto"]), tipFee: num(r["auto_mev"]) }
      : { nativeUsd, priorityFee: 0, tipFee: 0 };
  gasCache = { at: Date.now(), chain, q };
  return q;
}

// Paper legs now price their chain fees off this route too, so a monitor tick that sells three
// rungs would ask three times for numbers that move over minutes. One chain at a time is all the
// engine trades, so a single slot is the whole cache.
let gasCache: { at: number; chain: Chain; q: GasQuote } | null = null;

export type RouteQuote = {
  /** USD going in, and the USD the tokens coming back are worth. */
  inUsd: number;
  outUsd: number;
  /** Native units that actually leave the wallet — input plus every fee. 0 when not quoted. */
  costNative: number;
};

/**
 * What a swap would really cost, asked before anything is spent. Read-only (`exist` auth), so a
 * pre-trade refusal costs one weight-2 read and no money.
 *
 * The gap between `inUsd` and `outUsd` is the percentage half — GMGN's 1% routing fee, the pool's
 * own, and price impact — and `sol_cost` is the half no percentage models: priority fee, MEV tip
 * and account rent, flat whatever the trade is worth. Measured live on one pump_amm pool: a
 * 0.05 SOL buy quoted -2.2% on price and 0.0065 SOL of chain fees on top, which on a $3.78 buy
 * is another 13%. `sol_cost` is a slight overstatement — the ATA rent inside it comes back when
 * the account closes — and erring that way beats a paper record that flatters itself.
 */
export async function routeQuote(
  chain: Chain,
  from: string,
  inputToken: string,
  outputToken: string,
  amount: string,
  slippage: number,
): Promise<RouteQuote | null> {
  const r = obj(await client().quoteOrder(chain, fromAddress(chain, from), inputToken, outputToken, amount, slippage));
  const tx = obj(r["tx"]);
  const inUsd = num(tx["amount_in_usd"]);
  const outUsd = num(tx["amount_out_usd"]);
  if (!(inUsd > 0) || !(outUsd > 0)) return null;
  return { inUsd, outUsd, costNative: num(tx["sol_cost"]) / 10 ** NATIVE[chain].decimals };
}

export async function nativeUsdPrice(chain: Chain): Promise<number> {
  return (await gasQuote(chain)).nativeUsd;
}

export const NATIVE_SYMBOL: Record<string, string> = { sol: "SOL", bsc: "BNB", base: "ETH", eth: "ETH" };

/**
 * Native balance of the API-key-bound wallet, in whole units (SOL / BNB / ETH).
 *
 * `/v1/user/info` returns `{wallets: [{chain, address, balances: [{symbol, balance}]}]}` —
 * one entry per chain the key is bound to. Returns null when the wallet or its native row
 * is absent rather than a guess: sizing a real trade off an invented balance is worse than
 * not trading.
 */
export async function nativeBalance(chain: Chain, wallet: string): Promise<number | null> {
  const target = wallet.trim().toLowerCase();
  const w = list(await client().getUserInfo(), "wallets").find(
    (x) => String(x?.address ?? "").toLowerCase() === target && String(x?.chain ?? "").toLowerCase() === chain,
  );
  const row = list(w, "balances").find((b) => String(b?.symbol ?? "").toUpperCase() === NATIVE_SYMBOL[chain]);
  if (!row) return null;
  const bal = num(row.balance, -1);
  return bal >= 0 ? bal : null;
}

/**
 * Every token the wallet has touched, address → whole-unit balance. One call, so the monitor
 * can mirror GMGN instead of asking per position.
 *
 * Null means "the wallet could not be read" and must close nothing. An address *missing* from
 * the map means the same: the route pages, and a row absent from this page is not a zero. Only
 * an explicit `balance: "0"` is evidence that the position is gone — sold by the condition
 * orders attached at entry, or by the operator in GMGN's own UI.
 */
export async function walletHoldings(chain: Chain, wallet: string, limit = 100): Promise<Map<string, number> | null> {
  const r = obj(await client().getWalletHoldings(chain, wallet, { limit }));
  const rows = Array.isArray(r["list"]) ? r["list"] : Array.isArray(r["data"]?.list) ? r["data"].list : null;
  if (!rows) return null;
  const out = new Map<string, number>();
  for (const row of rows) {
    const addr = String(obj(row?.token)["token_address"] ?? "").toLowerCase();
    const qty = num(row?.balance, -1);
    if (addr && qty >= 0) out.set(addr, qty);
  }
  return out;
}

/** Withdraws the exit plan GMGN is holding for a position this process has just closed itself. */
export async function cancelStrategyOrder(chain: Chain, from: string, orderId: string): Promise<void> {
  await client().cancelStrategyOrder({ chain, from_address: fromAddress(chain, from), order_id: orderId });
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
  /** Let GMGN pick the tolerance per route instead of sending `slippage`. */
  autoSlippage?: boolean;
  antiMev?: boolean;
  /** Native units. Only sent with condition orders, where GMGN requires both. 0 = use the default. */
  priorityFee?: number;
  tipFee?: number;
  conditionOrders?: unknown[];
  sellRatioType?: "buy_amount" | "hold_amount";
};

/** Wallets are case-sensitive on Solana and lowercased everywhere else. */
const fromAddress = (chain: Chain, from: string) => (chain === "sol" ? from : from.toLowerCase());

/**
 * Submits a real, irreversible on-chain swap.
 *
 * This process signs its own trade requests, so the GMGN_ALLOW_AUTOMATED_TRADES check —
 * enforced in `OpenApiClient.swap`, before a request is even built — is the only thing
 * standing between a bug, or a token name the analyst was talked into trusting, and real
 * money. It is the operator's standing consent to headless execution: read it, never write
 * it, and do not add a config knob that can substitute for it.
 */
export async function swap(a: SwapArgs): Promise<SwapResult> {
  const params: SwapParams = {
    chain: a.chain,
    from_address: fromAddress(a.chain, a.from),
    input_token: a.inputToken,
    output_token: a.outputToken,
    // With a percent sell the amount field is a placeholder; bps carries the real size.
    input_amount: a.amount ?? "0",
    // Both fields at once is ambiguous, so it is one or the other.
    ...(a.autoSlippage ? { auto_slippage: true } : { slippage: a.slippage }),
  };
  if (a.percent != null) params.input_amount_bps = String(Math.round(a.percent * 100));
  if (a.antiMev && a.chain !== "base") params.is_anti_mev = true;
  if (a.conditionOrders?.length) {
    params.condition_orders = a.conditionOrders as SwapParams["condition_orders"];
    params.sell_ratio_type = a.sellRatioType ?? "hold_amount";
    // GMGN rejects condition_orders unless both fees are set. Preference order: the operator's
    // env override, then what the chain says it costs right now (`gasQuote`), then the constant.
    params.priority_fee = String(
      num(process.env.GMGN_PRIORITY_FEE || a.priorityFee || PRIORITY_FEE[a.chain], PRIORITY_FEE[a.chain]),
    );
    params.tip_fee = String(num(process.env.GMGN_TIP_FEE || a.tipFee || TIP_FEE[a.chain], TIP_FEE[a.chain]));
  }
  return obj(await client().swap(params)) as SwapResult;
}

export async function orderStatus(chain: Chain, orderId: string): Promise<SwapResult> {
  return obj(await client().queryOrder(orderId, chain)) as SwapResult;
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
