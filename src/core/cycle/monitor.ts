import { DUST_FRACTION, evaluateExit, healthExit, isDust } from "../domain/positions.ts";
import { num, short } from "../domain/num.ts";
import { store } from "../data/store.ts";
import * as broker from "../market/broker.ts";
import * as gmgn from "../market/gmgn.ts";
import * as jupiter from "../market/jupiter.ts";
import { aborted, generation } from "./control.ts";
import { bookSell, closePosition } from "./exits.ts";
import type { Position, TradeConfig } from "../domain/types.ts";

/**
 * The exit loop. Runs every `monitorSeconds` independently of the scan and never calls the
 * model — a position must never depend on an LLM call succeeding in order to be closed.
 *
 * In live mode the wallet is the book, not this ledger: a GMGN-bought position has its exit
 * plan on GMGN's side, and the operator can sell by hand, so positions shrink and vanish without
 * this process selling anything. One holdings read per tick mirrors that. For those positions
 * the two things GMGN was never told — the time stop and `healthExit` — are all this loop acts
 * on itself. A Jupiter-bought one (Solana) is the same while its take-profit and stop-loss sit
 * in Jupiter's vault (`jupiterExits`) — mirrored from the order history, since those tokens are
 * not in the wallet at all — and is run entirely from here once nothing is parked.
 */

async function readHoldings(cfg: TradeConfig): Promise<Map<string, number> | null> {
  try {
    return await gmgn.walletHoldings(cfg.chain, cfg.walletAddress);
  } catch (e) {
    store.log("warn", `Wallet holdings read failed: ${short(e)} — positions are not mirrored this tick.`);
    return null;
  }
}

/**
 * Mirrors one live position onto what the wallet actually holds. The exits run on GMGN's side,
 * so a position shrinks or disappears without this process selling anything — and the operator
 * can sell from GMGN's UI too. Whatever left the wallet is booked here.
 *
 * An unreadable wallet, or an address the holdings page did not carry, closes nothing: showing
 * a position a moment too long is recoverable, dropping a live one is not. The fill price is
 * GMGN's, not ours, so the booked PnL is an estimate at the last seen price.
 *
 * Returns true when the position is gone and the tick should move on.
 */
async function reconcile(p: Position, cfg: TradeConfig, held: number | undefined): Promise<boolean> {
  const gone = held === undefined ? 0 : p.qty - held;
  if (gone <= p.originalQty * DUST_FRACTION) return false;

  const res = broker.recordExternalSell(cfg, p, gone, "sold on GMGN's side (attached stop/TP or a manual sale)");
  if ("error" in res) return false;
  // The native it fetched is back in the wallet, so it is spendable again — same bookkeeping
  // as a sell this process made, and corrected by the next `syncLiveBalance` either way.
  store.cash += res.proceeds;
  store.log(
    "trade",
    `SELL ${p.symbol} ${((gone / p.originalQty) * 100).toFixed(0)}% — $${res.proceeds.toFixed(2)} (estimated at the last seen price)`,
    "closed outside the agent; booked from the wallet balance",
  );
  await bookSell(p, cfg, gone, res.proceeds, res.trade);
  return isDust(p);
}

/**
 * What the wallet holds of a Jupiter-bought position, straight off the chain. GMGN's holdings
 * index is not asked: it trails a withdrawal from the vault, and a stale zero there would book
 * a position that has just come back to the wallet as sold.
 */
async function walletQty(p: Position, cfg: TradeConfig): Promise<number | undefined> {
  try {
    return Number(await jupiter.tokenBalance(cfg.walletAddress, p.address)) / 10 ** p.decimals!;
  } catch (e) {
    store.log("warn", `Wallet balance read failed for ${p.symbol}: ${short(e)} — not mirrored this tick.`);
    return undefined;
  }
}

async function readOrders(): Promise<jupiter.OrderRow[] | null> {
  try {
    return await jupiter.orders();
  } catch (e) {
    store.log("warn", `Jupiter order history read failed: ${short(e)} — parked exits are not mirrored this tick.`);
    return null;
  }
}

/**
 * Mirrors a position whose exits are parked on Jupiter. Every order that has finished and sold
 * something is booked once, at what it actually fetched — unlike a wallet mirror, this one
 * knows the proceeds. Rows are matched by mint and age rather than by order id, because an OCO
 * pair is two legs and only the one that filled reports an amount.
 *
 * When no order is live any more the position stops being parked: whatever is left is in the
 * wallet (cancelled by this process) or was never sold, and the monitor runs it from here.
 * An unreadable history changes nothing.
 *
 * Returns true when the position is gone.
 */
async function reconcileOrders(p: Position, cfg: TradeConfig, rows: jupiter.OrderRow[] | null): Promise<boolean> {
  if (!rows) return false;
  const mine = rows.filter((r) => r.inputMint === p.address && r.createdAt >= p.openedAt);
  const live = (r: jupiter.OrderRow) => jupiter.ORDER_LIVE.includes(r.orderState);

  for (const r of mine) {
    const sold = num(r.inputUsed) / 10 ** (p.decimals ?? 0);
    if (live(r) || !(sold > 0) || p.bookedFills?.includes(r.id)) continue;
    const qty = Math.min(p.qty, sold);
    const nativeUsd = await gmgn.nativeUsdPrice(cfg.chain).catch(() => 0);
    const fetched = (num(r.outputAmount) / 1e9) * nativeUsd;
    const res = broker.recordExternalSell(cfg, p, qty, "take-profit / stop-loss order filled on Jupiter", fetched > 0 ? fetched : undefined);
    if ("error" in res) continue;
    (p.bookedFills ??= []).push(r.id);
    store.cash += res.proceeds;
    const pnl = res.trade.pnlUsd ?? 0;
    store.log(
      "trade",
      `SELL ${p.symbol} ${((qty / p.originalQty) * 100).toFixed(0)}% — $${res.proceeds.toFixed(2)} · ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} (${(res.trade.pnlPct ?? 0).toFixed(1)}%)`,
      "filled by an order parked on Jupiter",
    );
    await bookSell(p, cfg, qty, res.proceeds, res.trade);
    if (isDust(p)) return true;
  }

  // No rows at all is not evidence of anything — a history that has not caught up with an order
  // placed seconds ago must not un-park a position whose tokens are in the vault.
  if (mine.length && !mine.some(live)) {
    // ponytail: an order that expired or failed still holds its tokens in the vault, and they
    // read as a wallet shortfall from here. Orders run 30 days and the time stop is hours, so
    // only a `failed` gets here — withdraw it by hand if this log line ever appears.
    if (mine.some((r) => ["expired", "failed"].includes(r.orderState)))
      store.log("error", `${p.symbol}: a Jupiter order expired or failed — its tokens may still be in the vault. Check jup.ag.`);
    delete p.jupiterExits;
    store.save();
  }
  return false;
}


/** Only one tick runs at a time — a slow book must not overlap the next interval. */
let monitoring = false;

export async function runMonitor(): Promise<void> {
  if (monitoring || !store.positions.length) return;
  monitoring = true;
  const gen = generation();
  try {
    const cfg = store.config;
    // One read for the whole wallet, before anything else: in live mode GMGN's copy of the
    // book is the real one, and every position below is checked against it.
    // Positions that know their decimals are read off the chain instead, and parked ones off
    // Jupiter's order history — one read each, and only when a position needs it.
    const live = cfg.mode === "live";
    const holdings = live && store.positions.some((p) => p.decimals == null) ? await readHoldings(cfg) : null;
    const orders = live && store.positions.some((p) => p.jupiterExits) ? await readOrders() : null;

    for (const p of [...store.positions]) {
      // One price read per position, so a tick over a full book outlives a Stop by a while.
      // Whatever is left of it belongs to a run the operator ended.
      if (aborted(gen)) break;
      await checkPosition(p, cfg, holdings, orders);
    }
    store.save();
    store.markEquity();
    store.push();
  } catch (e) {
    store.log("error", `Monitor tick failed: ${short(e)}`);
  } finally {
    monitoring = false;
  }
}

/** One position against one fresh price: mirror the wallet, then run the exit plan. */
async function checkPosition(
  p: Position,
  cfg: TradeConfig,
  holdings: Map<string, number> | null,
  orders: jupiter.OrderRow[] | null,
): Promise<void> {
  let info: Record<string, any> | null = null;
  try {
    info = await gmgn.tokenInfo(p.chain, p.address);
  } catch (e) {
    // No return. The time stop is a clock, not a price rule, and a position whose price
    // cannot be read is exactly the one that must not sit open forever. Everything below
    // survives a missing read: `healthExit` ignores an absent liquidity figure, and the
    // price rules are held back at the exit gate.
    store.log("warn", `Price refresh failed for ${p.symbol}: ${short(e)}`);
  }
  const price = num(info?.price?.price);
  if (price > 0) {
    p.lastPrice = price;
    p.peakPrice = Math.max(p.peakPrice, price);
  }

  if (cfg.mode === "live") {
    const gone = p.jupiterExits
      ? await reconcileOrders(p, cfg, orders)
      : await reconcile(p, cfg, p.decimals != null ? await walletQty(p, cfg) : holdings?.get(p.address.toLowerCase()));
    if (gone) return;
  }

  const health = healthExit(p, info ?? {});
  if (health) {
    await closePosition(p, health.percent, health.reason);
    return;
  }

  const exit = evaluateExit(p, cfg);
  if (!exit) return;
  // A position bought through GMGN carries its whole plan on GMGN's side (`strategyOrderId`),
  // so acting on a price rule here would be a second sell for an exit that is already placed.
  // What is left is the two things GMGN was never told: the time stop, and the health exit
  // above it. The same goes for a Jupiter position while its take-profit and stop-loss are
  // parked there (`jupiterExits`). With nothing parked, the plan runs here like a paper one.
  // Same on a failed read, whatever the mode: `lastPrice` is stale, so only the clock is
  // still telling the truth.
  if ((p.strategyOrderId || p.jupiterExits || !info) && exit.kind !== "time") return;
  const rung = /^(?:tp|rule)(\d+)$/.exec(exit.kind);
  if (rung?.[1]) p.filledRungs.push(Number(rung[1]));
  await closePosition(p, exit.percent, exit.reason);
}
