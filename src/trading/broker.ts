import { randomUUID } from "node:crypto";
import { NATIVE } from "./config.ts";
import * as gmgn from "./market.ts";
import { num } from "./market.ts";
import type { store as Store } from "./store.ts";
import type { Candidate, Position, TradeConfig, Trade } from "./types.ts";

/** GMGN's routing fee, applied to both legs of a paper trade. */
const FEE_PCT = 1.0;

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

export type BuyResult = { position: Position; trade: Trade } | { error: string };

export async function buy(
  store: typeof Store,
  cfg: TradeConfig,
  c: Candidate,
  usdAmount: number,
  thesis: string,
  conviction: number,
  stopLossPct: number,
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

  if (cfg.mode === "paper") {
    const slip = paperSlip(usdAmount, c.liquidityUsd, cfg.slippagePct);
    fillPrice = c.priceUsd * (1 + slip / 100);
    const net = usdAmount * (1 - FEE_PCT / 100);
    qty = net / fillPrice;
    if (store.cash < usdAmount) return { error: "not enough paper cash" };
    store.cash -= usdAmount;
  } else {
    const native = NATIVE[cfg.chain];
    const nativeUsd = await gmgn.nativeUsdPrice(cfg.chain);
    if (!(nativeUsd > 0)) return { error: "could not read native token price" };
    const amount = toSmallestUnit(usdAmount / nativeUsd, native.decimals);

    // Protection is attached to the buy itself, so the position keeps a stop even
    // if this process dies a second after the fill.
    const conditionOrders = [
      ...cfg.takeProfit.map((r) => ({
        order_type: "profit_stop",
        side: "sell",
        price_scale: String(r.at),
        sell_ratio: String(r.sell),
      })),
      { order_type: "loss_stop", side: "sell", price_scale: String(Math.round(stopLossPct)), sell_ratio: "100" },
    ];

    const res = await gmgn.swap({
      chain: cfg.chain,
      from: cfg.walletAddress,
      inputToken: native.address,
      outputToken: c.address,
      amount,
      slippage: cfg.slippagePct,
      antiMev: true,
      conditionOrders,
      sellRatioType: "hold_amount",
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
    spent = inAmt > 0 ? inAmt * nativeUsd : usdAmount;
    txHash = settled.hash;
  }

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
    filledRungs: [],
    trailArmed: false,
    thesis,
    conviction,
    stopLossPct,
    entryLiquidityUsd: c.liquidityUsd,
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

  const now = Date.now();
  let fillPrice = p.lastPrice;
  let proceeds = 0;
  let txHash: string | undefined;
  let orderId: string | undefined;

  if (cfg.mode === "paper") {
    const gross = qtySold * p.lastPrice;
    const slip = paperSlip(gross, liquidityUsd || gross * 20, cfg.slippagePct);
    fillPrice = p.lastPrice * (1 - slip / 100);
    proceeds = qtySold * fillPrice * (1 - FEE_PCT / 100);
    store.cash += proceeds;
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

  // Cost basis for the slice being sold, so partial exits report honest PnL.
  const costBasis = (p.costUsd * qtySold) / p.originalQty;
  const pnlUsd = proceeds - costBasis;

  const trade: Trade = {
    id: randomUUID(),
    chain: cfg.chain,
    address: p.address,
    symbol: p.symbol,
    side: "sell",
    mode: cfg.mode,
    at: now,
    price: fillPrice,
    qty: qtySold,
    usd: proceeds,
    pnlUsd,
    pnlPct: costBasis > 0 ? (pnlUsd / costBasis) * 100 : 0,
    reason,
    ...(txHash ? { txHash } : {}),
    ...(orderId ? { orderId } : {}),
  };

  return { trade, qtySold, proceeds };
}
