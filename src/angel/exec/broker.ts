import { randomUUID } from "node:crypto";
import { breakevenPct, MAX_ENTRY_COST_PCT, minLegUsd, NATIVE, netOfFees, num, slippage } from "../core/config.ts";
import { viableStrategy } from "../core/plan.ts";
import * as gmgn from "./market.ts";
import type { store as Store } from "../state/store.ts";
import type { Candidate, Position, StrategyRule, TradeConfig, Trade } from "../core/types.ts";

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

export type ConditionOrder = {
  order_type: string;
  side: "sell";
  price_scale?: string;
  drawdown_rate?: string;
  sell_ratio: string;
};

const pctStr = (n: number) => String(Math.max(1, Math.round(Math.abs(n))));

/**
 * The position's exit plan in GMGN's vocabulary, attached to the buy itself.
 *
 * In live mode these are the exits: GMGN runs them on its own side and the monitor loop mirrors
 * the result instead of racing it, so every rule the plan can express has to make the trip —
 * including the trailing ones, which is what the `*_trace` order types are for. Everything is a
 * percentage: `price_scale` is the move from entry (unsigned on the loss side — "18" means 18%
 * down), `drawdown_rate` the callback from the peak, `sell_ratio` the slice to sell.
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
    else if (r.kind === "ttp" && r.at != null && r.dd != null)
      out.push({ order_type: "profit_stop_trace", side: "sell", price_scale: pctStr(r.at), drawdown_rate: pctStr(r.dd), sell_ratio });
    else if (r.kind === "tsl" && r.dd != null)
      out.push({ order_type: "loss_stop_trace", side: "sell", drawdown_rate: pctStr(r.dd), sell_ratio });
  }

  // The legacy path: a position with no rule set runs on the config's ladder and trail.
  if (!strategy.length) {
    for (const r of cfg.takeProfit)
      out.push({ order_type: "profit_stop", side: "sell", price_scale: pctStr(r.at), sell_ratio: pctStr(r.sell) });
    out.push({
      order_type: "profit_stop_trace",
      side: "sell",
      price_scale: pctStr(cfg.trailArmPct),
      drawdown_rate: pctStr(cfg.trailGivebackPct),
      sell_ratio: "100",
    });
  }

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

  let fillPrice = c.priceUsd;
  let qty = 0;
  let spent = usdAmount;
  let txHash: string | undefined;
  let orderId: string | undefined;
  let strategyOrderId: string | undefined;

  const native = NATIVE[cfg.chain];
  // One call for the native price and the current fees — the swap needs both, and paper prices
  // its own fees off the same numbers. Cached for 30s, so a cycle asks once.
  const gas = await gmgn.gasQuote(cfg.chain).catch(() => ({ nativeUsd: 0, priorityFee: 0, tipFee: 0 }));
  const nativeUsd = gas.nativeUsd;
  const amount = nativeUsd > 0 ? toSmallestUnit(usdAmount / nativeUsd, native.decimals) : "";

  // What the route really costs, before anything is spent. Both modes ask: live to refuse a buy
  // that starts too far under, paper to fill on a real number instead of a model of one. Needs a
  // wallet address — GMGN quotes a route for someone — and falls back to the model without it.
  const quote =
    amount && cfg.walletAddress
      ? await gmgn
          .routeQuote(cfg.chain, cfg.walletAddress, native.address, c.address, amount, slippage(cfg))
          .catch(() => null)
      : null;
  const quotedCost = quote ? (quote.costNative > 0 ? quote.costNative * nativeUsd : quote.inUsd) : 0;
  if (quote && quotedCost > 0) {
    const entryCostPct = ((quotedCost - quote.outUsd) / quotedCost) * 100;
    if (entryCostPct > MAX_ENTRY_COST_PCT)
      return {
        error: `entry costs ${entryCostPct.toFixed(1)}% on a $${usdAmount.toFixed(0)} buy (fees + impact, ceiling ${MAX_ENTRY_COST_PCT}%) — too small for the round trip`,
      };
  }

  // What this position has to gain before it is worth anything, and the plan the fees allow of
  // the one it was given: targets under the hurdle lifted to it, rungs too small to pay for
  // their own transaction folded together. Priced before the branch, so live hands GMGN exactly
  // the plan paper would have run.
  const hurdle = breakevenPct(cfg.chain, quotedCost > 0 ? quote!.inUsd : usdAmount, nativeUsd, quotedCost);
  const plan = viableStrategy(strategy, hurdle, minLegUsd(cfg.chain, nativeUsd), usdAmount);
  if (plan.length !== strategy.length)
    store.log(
      "info",
      `${c.symbol}: exit plan repriced — ${strategy.length} rules into ${plan.length}, break-even +${hurdle.toFixed(1)}% on $${usdAmount.toFixed(0)}.`,
    );

  if (cfg.mode === "paper") {
    if (quote && quotedCost > 0) {
      // The quoted route, not a model of one. `outUsd` is what the tokens are worth on arrival,
      // `quotedCost` everything that leaves the wallet to get them. Entry price stays a market
      // price — live's convention — so the chain fees land in `costUsd` where they belong and
      // the exit rules read the same percentages in either mode.
      qty = quote.outUsd / c.priceUsd;
      fillPrice = quote.inUsd / qty;
      spent = quotedCost;
    } else {
      const slip = paperSlip(usdAmount, c.liquidityUsd, slippage(cfg));
      fillPrice = c.priceUsd * (1 + slip / 100);
      qty = netOfFees(cfg.chain, usdAmount, nativeUsd) / fillPrice;
    }
    if (store.cash < spent) return { error: "not enough paper cash" };
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
    const settled = res.order_id ? await gmgn.waitForOrder(cfg.chain, res.order_id) : res;
    const status = (settled.status ?? "").toLowerCase();
    if (["failed", "expired"].includes(status))
      return { error: `swap ${status}: ${settled.error_status ?? settled.error_code ?? "unknown"}` };

    const rep = settled.report ?? {};
    const outDec = num(rep.output_token_decimals, 9);
    qty = num(rep.output_amount) / 10 ** outDec;
    fillPrice = num(rep.price_usd) || c.priceUsd;
    if (!(qty > 0)) return { error: "swap returned no output amount" };
    const inDec = num(rep.input_token_decimals, NATIVE[cfg.chain].decimals);
    const inAmt = num(rep.input_amount) / 10 ** inDec;
    // The report accounts for the amount swapped, never the routing fee or the chain fees paid
    // around it — real money that left the wallet, and the difference between a cost basis and a
    // flattering one. The quote's `sol_cost` is the only number that carries them, so when it is
    // there the gap rides along as an estimate; without it the basis stays understated.
    const overhead = quote && quotedCost > quote.inUsd ? quotedCost - quote.inUsd : 0;
    spent = (inAmt > 0 ? inAmt * nativeUsd : usdAmount) + overhead;
    txHash = settled.hash;
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
    trailArmed: false,
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
    const settled = res.order_id ? await gmgn.waitForOrder(cfg.chain, res.order_id) : res;
    const status = (settled.status ?? "").toLowerCase();
    if (["failed", "expired"].includes(status))
      return { error: `sell ${status}: ${settled.error_status ?? settled.error_code ?? "unknown"}` };
    const rep = settled.report ?? {};
    fillPrice = num(rep.price_usd) || p.lastPrice;
    const outDec = num(rep.output_token_decimals, NATIVE[cfg.chain].decimals);
    const outAmt = num(rep.output_amount) / 10 ** outDec;
    const nativeUsd = await gmgn.nativeUsdPrice(cfg.chain).catch(() => 0);
    proceeds = outAmt > 0 && nativeUsd > 0 ? outAmt * nativeUsd : qtySold * fillPrice;
    txHash = settled.hash;
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
    reason,
    ...(txHash ? { txHash } : {}),
    ...(orderId ? { orderId } : {}),
  };
}

/**
 * Books an exit that already happened somewhere else — the stop/take-profit orders GMGN runs
 * on its own side, or a manual sale from the GMGN UI. Submits nothing; the tokens are gone.
 * The fill price is unknown here, so the last seen price stands in and the PnL on this trade
 * is an estimate — the alternative is a position the dashboard shows forever.
 */
export function recordExternalSell(cfg: TradeConfig, p: Position, qtySold: number, reason: string): SellResult {
  const proceeds = qtySold * p.lastPrice;
  return { trade: sellTrade(cfg, p, qtySold, p.lastPrice, proceeds, reason), qtySold, proceeds };
}
