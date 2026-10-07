import { breakevenPct, NATIVE, netOfFees } from "../domain/chains.ts";
import { slippage } from "../domain/config.ts";
import { num, short } from "../domain/num.ts";
import { peakPct } from "../domain/positions.ts";
import type { store as Store } from "../data/store.ts";
import type { Candidate, Chain, Position, StrategyRule, Trade, TradeConfig } from "../domain/types.ts";
import { randomUUID } from "node:crypto";
import * as gmgn from "./gmgn.ts";
import * as jupiter from "./jupiter.ts";

/**
 * Live Solana swaps go through Jupiter and are signed here, so the wallet that trades is
 * whichever one `SOLANA_PRIVATE_KEY` belongs to — not the one picked on the dashboard. The two
 * must agree, or balances and holdings would be read off one wallet and spent from another.
 */
function jupiterWalletError(cfg: TradeConfig): string | null {
  const mine = jupiter.address();
  if (!mine) return "SOLANA_PRIVATE_KEY is not set or not a valid Solana key";
  return mine === cfg.walletAddress ? null : `SOLANA_PRIVATE_KEY signs for ${mine}, not the selected wallet ${cfg.walletAddress}`;
}

/** Price impact a paper fill should expect, given trade size against pool depth. */
function paperSlip(usd: number, liquidityUsd: number, cap: number): number {
  const impact = liquidityUsd > 0 ? (usd / liquidityUsd) * 100 : 2;
  return Math.min(cap, 0.4 + impact);
}

function toSmallestUnit(amount: number, decimals: number): string {
  // Avoid float noise in the low digits by formatting through a fixed string.
  const [whole = "0", frac = ""] = amount.toFixed(Math.min(decimals, 18)).split(".");
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return (BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || "0")).toString();
}

/**
 * Wait for a submitted swap to land, then hand back the fill report. `waitForOrder` polls until
 * GMGN calls the order settled one way or the other, so a failed status here is a failed trade
 * and not a read that gave up; an order with no id never made it that far and answers for itself.
 */
export async function settle(
  chain: Chain,
  res: gmgn.SwapResult,
  verb: string,
): Promise<{ report: Record<string, any>; hash?: string } | { error: string }> {
  const settled = res.order_id ? await gmgn.waitForOrder(chain, res.order_id) : res;
  const status = (settled.status ?? "").toLowerCase();
  if (["failed", "expired"].includes(status))
    return { error: `${verb} ${status}: ${settled.error_status ?? settled.error_code ?? "unknown"}` };
  return { report: settled.report ?? {}, hash: settled.hash };
}

export type ConditionOrder = {
  order_type: string;
  side: "sell";
  price_scale?: string;
  sell_ratio: string;
};

const pctStr = (n: number) => String(Math.max(1, Math.round(Math.abs(n))));

/**
 * The position's exit plan in GMGN's vocabulary, attached to the buy itself.
 *
 * In live mode these are the exits: GMGN runs them on its own side and the monitor loop mirrors
 * the result instead of racing it, so every rule the plan can express has to make the trip.
 * Everything is a percentage: `price_scale` is the move from entry (unsigned on the loss side —
 * "18" means 18% down), `sell_ratio` the slice to sell.
 *
 * The slice is a share of the *bought* amount (`sell_ratio_type: buy_amount` at the call site),
 * which is what `StrategyRule.sell` has always meant — under `hold_amount` a two-rung ladder
 * sells the second rung out of what the first one left, and the plan silently shrinks.
 *
 * A stop is appended when the plan has none, mirroring `entryStrategy`: the position must never
 * sit on GMGN's side without a floor.
 */
export function conditionOrders(cfg: TradeConfig, strategy: StrategyRule[], stopLossPct: number): ConditionOrder[] {
  const out: ConditionOrder[] = [];
  for (const r of strategy) {
    const sell_ratio = pctStr(r.sell);
    if (r.kind === "tp" && r.at != null) out.push({ order_type: "profit_stop", side: "sell", price_scale: pctStr(r.at), sell_ratio });
    else if (r.kind === "sl" && r.at != null) out.push({ order_type: "loss_stop", side: "sell", price_scale: pctStr(r.at), sell_ratio });
  }

  // The legacy path: a position with no rule set runs on the config's ladder.
  if (!strategy.length)
    for (const r of cfg.takeProfit)
      out.push({ order_type: "profit_stop", side: "sell", price_scale: pctStr(r.at), sell_ratio: pctStr(r.sell) });

  if (!out.some((o) => o.order_type === "loss_stop"))
    out.push({ order_type: "loss_stop", side: "sell", price_scale: pctStr(stopLossPct), sell_ratio: "100" });
  return out;
}

export type BuyResult = { position: Position; trade: Trade } | { error: string };

export async function buy(
  store: typeof Store,
  cfg: TradeConfig,
  c: Candidate,
  usdAmount: number,
  thesis: string,
  conviction: number,
  stopLossPct: number,
  strategy: StrategyRule[] = [],
): Promise<BuyResult> {
  if (usdAmount < 1) return { error: "size below $1" };
  const now = Date.now();
  const id = randomUUID();

  const native = NATIVE[cfg.chain];
  // One call for the native price and the current fees — the swap needs both, and paper prices
  // its own fees off the same numbers. Cached for 30s, so a cycle asks once.
  const gas = await gmgn.gasQuote(cfg.chain).catch(() => ({ nativeUsd: 0, priorityFee: 0, tipFee: 0 }));
  const nativeUsd = gas.nativeUsd;
  const amount = nativeUsd > 0 ? toSmallestUnit(usdAmount / nativeUsd, native.decimals) : "";

  // No pre-trade `/v1/trade/quote`: GMGN answers it with RATE_LIMIT_EXCEEDED even as the first
  // request after 90s of silence, and that 429 shut the shared gate so the swap behind it went out
  // at reset+1s and was refused too — every live buy this route was asked for failed that way.
  // Fees and impact are the model's (`breakevenPct`, `paperSlip`) in both modes.

  // What this position has to gain before it is worth anything. The plan runs as written, the
  // analyst's as much as the operator's — a target used to be lifted over break-even and the
  // stop distance, and the operator took that out. What the floor would have caught is said out
  // loud instead.
  const hurdle = breakevenPct(cfg.chain, usdAmount, nativeUsd);
  const plan = strategy;
  const under = plan.filter((r) => r.kind === "tp" && (r.at ?? 0) < hurdle).map((r) => `+${r.at}%`);
  if (under.length)
    store.log("warn", `${c.symbol}: exit plan kept as written — ${under.join(", ")} is under break-even (+${hurdle.toFixed(1)}% on $${usdAmount.toFixed(0)}) and sells at a loss.`);

  // Filled in by whichever branch runs.
  let fillPrice = c.priceUsd;
  let qty = 0;
  let spent = usdAmount;
  let txHash: string | undefined;
  let orderId: string | undefined;
  let strategyOrderId: string | undefined;
  let decimals: number | undefined;

  if (cfg.mode === "paper") {
    const slip = paperSlip(usdAmount, c.liquidityUsd, slippage(cfg));
    fillPrice = c.priceUsd * (1 + slip / 100);
    qty = netOfFees(cfg.chain, usdAmount, nativeUsd) / fillPrice;
    if (store.cash < spent) return { error: "not enough paper cash" };
  } else if (cfg.chain === "sol") {
    // Jupiter is the swap and nothing else: no condition orders ride along, and nothing is
    // parked there afterwards. The monitor runs the whole exit plan, as it does in paper.
    if (!(nativeUsd > 0)) return { error: "could not read native token price" };
    const bad = jupiterWalletError(cfg);
    if (bad) return { error: bad };
    // Before the swap, not after: a fill that cannot be converted to a quantity cannot be booked.
    let dec: number;
    try {
      dec = decimals = await jupiter.decimals(c.address);
    } catch (e) {
      return { error: `could not read token decimals: ${short(e)}` };
    }
    const fill = await jupiter.swap({ inputMint: native.address, outputMint: c.address, amount, slippagePct: cfg.slippagePct });
    if ("error" in fill) return fill;
    qty = num(fill.outAmount) / 10 ** dec;
    if (!(qty > 0)) return { error: "swap returned no output amount" };
    const inAmt = num(fill.inAmount) / 10 ** native.decimals;
    spent = inAmt > 0 ? inAmt * nativeUsd : usdAmount;
    // What a token actually cost, Jupiter's fee and the slippage included — `/execute` reports
    // amounts, not a price.
    fillPrice = spent / qty;
    txHash = fill.signature;
  } else {
    if (!(nativeUsd > 0)) return { error: "could not read native token price" };

    const res = await gmgn.swap({
      chain: cfg.chain,
      from: cfg.walletAddress,
      inputToken: native.address,
      outputToken: c.address,
      amount,
      slippage: cfg.slippagePct,
      autoSlippage: cfg.slippagePct === 0,
      antiMev: true,
      priorityFee: gas.priorityFee,
      tipFee: gas.tipFee,
      conditionOrders: conditionOrders(cfg, plan, stopLossPct),
      sellRatioType: "buy_amount",
    });
    orderId = res.order_id;
    strategyOrderId = res.strategy_order_id;
    const fill = await settle(cfg.chain, res, "swap");
    if ("error" in fill) return fill;

    const rep = fill.report;
    const outDec = num(rep.output_token_decimals, 9);
    qty = num(rep.output_amount) / 10 ** outDec;
    fillPrice = num(rep.price_usd) || c.priceUsd;
    if (!(qty > 0)) return { error: "swap returned no output amount" };
    const inDec = num(rep.input_token_decimals, NATIVE[cfg.chain].decimals);
    const inAmt = num(rep.input_amount) / 10 ** inDec;
    // The report accounts for the amount swapped, never the routing fee or the chain fees paid
    // around it, so this basis is understated by those — there is no quote left to estimate them.
    spent = inAmt > 0 ? inAmt * nativeUsd : usdAmount;
    txHash = fill.hash;
  }

  // Both modes: cash is what is left to deploy, and equity is cash + exposure. Leaving it
  // untouched on a live fill counted the same money twice — once as unspent cash, once as
  // the position it just bought. The next `syncLiveBalance` overwrites this with the wallet's
  // own figure; between two scans, this is what keeps the readout honest.
  store.cash -= spent;

  const position: Position = {
    id,
    chain: cfg.chain,
    address: c.address,
    symbol: c.symbol,
    openedAt: now,
    costUsd: spent,
    qty,
    originalQty: qty,
    entryPrice: fillPrice,
    lastPrice: fillPrice,
    peakPrice: fillPrice,
    realisedUsd: 0,
    ...(plan.length ? { strategy: plan } : {}),
    filledRungs: [],
    thesis,
    conviction,
    stopLossPct,
    // Re-measured off the fill that actually happened, so every exit rule from here on is
    // checked against this position's own round trip rather than an average one.
    breakevenPct: Number(breakevenPct(cfg.chain, qty * fillPrice, nativeUsd, spent).toFixed(2)),
    entryLiquidityUsd: c.liquidityUsd,
    // Priced off the fill, not off the scan: the candidate's own mcap/price pair gives the
    // supply, and the fill is what this position actually entered at. Keeping it consistent
    // with `entryPrice` is what lets the dashboard scale it to a current market cap.
    ...(c.marketCapUsd > 0 && c.priceUsd > 0
      ? { entryMarketCapUsd: (c.marketCapUsd / c.priceUsd) * fillPrice }
      : {}),
    ...(orderId ? { orderId } : {}),
    ...(strategyOrderId ? { strategyOrderId } : {}),
    ...(decimals != null ? { decimals } : {}),
  };

  const trade: Trade = {
    id: randomUUID(),
    chain: cfg.chain,
    address: c.address,
    symbol: c.symbol,
    side: "buy",
    mode: cfg.mode,
    at: now,
    price: fillPrice,
    qty,
    usd: spent,
    reason: thesis.slice(0, 200),
    ...(txHash ? { txHash } : {}),
    ...(orderId ? { orderId } : {}),
  };

  return { position, trade };
}

export type SellResult = { trade: Trade; qtySold: number; proceeds: number } | { error: string };

export async function sell(
  store: typeof Store,
  cfg: TradeConfig,
  p: Position,
  percentOfOriginal: number,
  reason: string,
  liquidityUsd = 0,
): Promise<SellResult> {
  const wanted = (p.originalQty * percentOfOriginal) / 100;
  const qtySold = Math.min(p.qty, wanted);
  if (!(qtySold > 0)) return { error: "nothing left to sell" };

  let fillPrice = p.lastPrice;
  let proceeds = 0;
  let txHash: string | undefined;
  let orderId: string | undefined;

  if (cfg.mode === "paper") {
    const gross = qtySold * p.lastPrice;
    const slip = paperSlip(gross, liquidityUsd || gross * 20, slippage(cfg));
    fillPrice = p.lastPrice * (1 - slip / 100);
    // The exit pays the same two costs the entry did, and the flat one does not care that this
    // is a rung: selling 20% of a $20 position nets ~$3.5 and still pays its ~$0.45 of chain
    // fees. A ladder is four of those. Quoting the route back would need the token's decimals,
    // which nothing here carries — the model is close enough, and it is no longer zero.
    const nativeUsd = await gmgn.nativeUsdPrice(cfg.chain).catch(() => 0);
    proceeds = netOfFees(cfg.chain, qtySold * fillPrice, nativeUsd);
  } else if (cfg.chain === "sol") {
    const bad = jupiterWalletError(cfg);
    if (bad) return { error: bad };
    // Sized off what the wallet holds right now, like GMGN's percent sell: the ledger's `qty`
    // is a float, and asking for one unit more than the balance is a refused swap.
    const pctOfBalance = Math.max(1, Math.min(100, Math.round((qtySold / p.qty) * 100)));
    const held = await jupiter.tokenBalance(cfg.walletAddress, p.address);
    const raw = (held * BigInt(pctOfBalance)) / 100n;
    if (raw <= 0n) return { error: "the wallet holds none of this token" };
    const fill = await jupiter.swap({
      inputMint: p.address,
      outputMint: NATIVE[cfg.chain].address,
      amount: raw.toString(),
      slippagePct: cfg.slippagePct,
    });
    if ("error" in fill) return fill;
    const outAmt = num(fill.outAmount) / 10 ** NATIVE[cfg.chain].decimals;
    const nativeUsd = await gmgn.nativeUsdPrice(cfg.chain).catch(() => 0);
    proceeds = outAmt > 0 && nativeUsd > 0 ? outAmt * nativeUsd : qtySold * p.lastPrice;
    fillPrice = proceeds / qtySold;
    txHash = fill.signature;
  } else {
    // `--percent` is a share of the wallet's current balance, not of the original buy.
    const pctOfBalance = Math.max(1, Math.min(100, Math.round((qtySold / p.qty) * 100)));
    const res = await gmgn.swap({
      chain: cfg.chain,
      from: cfg.walletAddress,
      inputToken: p.address,
      outputToken: NATIVE[cfg.chain].address,
      percent: pctOfBalance,
      slippage: cfg.slippagePct,
      autoSlippage: cfg.slippagePct === 0,
      antiMev: true,
    });
    orderId = res.order_id;
    const fill = await settle(cfg.chain, res, "sell");
    if ("error" in fill) return fill;
    const rep = fill.report;
    fillPrice = num(rep.price_usd) || p.lastPrice;
    const outDec = num(rep.output_token_decimals, NATIVE[cfg.chain].decimals);
    const outAmt = num(rep.output_amount) / 10 ** outDec;
    const nativeUsd = await gmgn.nativeUsdPrice(cfg.chain).catch(() => 0);
    proceeds = outAmt > 0 && nativeUsd > 0 ? outAmt * nativeUsd : qtySold * fillPrice;
    txHash = fill.hash;
  }

  store.cash += proceeds;
  return { trade: sellTrade(cfg, p, qtySold, fillPrice, proceeds, reason, txHash, orderId), qtySold, proceeds };
}

function sellTrade(
  cfg: TradeConfig,
  p: Position,
  qtySold: number,
  fillPrice: number,
  proceeds: number,
  reason: string,
  txHash?: string,
  orderId?: string,
): Trade {
  // Cost basis for the slice being sold, so partial exits report honest PnL.
  const costBasis = (p.costUsd * qtySold) / p.originalQty;
  const pnlUsd = proceeds - costBasis;
  return {
    id: randomUUID(),
    chain: cfg.chain,
    address: p.address,
    symbol: p.symbol,
    side: "sell",
    mode: cfg.mode,
    at: Date.now(),
    price: fillPrice,
    qty: qtySold,
    usd: proceeds,
    pnlUsd,
    pnlPct: costBasis > 0 ? (pnlUsd / costBasis) * 100 : 0,
    peakPct: peakPct(p),
    reason,
    ...(txHash ? { txHash } : {}),
    ...(orderId ? { orderId } : {}),
  };
}

/**
 * Books an exit that already happened somewhere else — the stop/take-profit orders GMGN runs
 * on its own side, or a manual sale. Submits nothing; the tokens are gone. The fill price is
 * unknown, so the last seen price stands in and the PnL on this trade is an estimate — the
 * alternative is a position the dashboard shows forever.
 */
export function recordExternalSell(cfg: TradeConfig, p: Position, qtySold: number, reason: string): SellResult {
  const proceeds = qtySold * p.lastPrice;
  return { trade: sellTrade(cfg, p, qtySold, proceeds / qtySold, proceeds, reason), qtySold, proceeds };
}
