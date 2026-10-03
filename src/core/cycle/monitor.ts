import { DUST_FRACTION, evaluateExit, healthExit, isDust } from "../domain/positions.ts";
import { num, short } from "../domain/num.ts";
import { store } from "../data/store.ts";
import * as broker from "../market/broker.ts";
import * as gmgn from "../market/gmgn.ts";
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
 * on itself; a Jupiter-bought one (Solana) has no plan anywhere else, so this loop is its exits.
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
async function reconcile(p: Position, cfg: TradeConfig, holdings: Map<string, number> | null): Promise<boolean> {
  const held = holdings?.get(p.address.toLowerCase());
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
    const holdings = cfg.mode === "live" ? await readHoldings(cfg) : null;

    for (const p of [...store.positions]) {
      // One price read per position, so a tick over a full book outlives a Stop by a while.
      // Whatever is left of it belongs to a run the operator ended.
      if (aborted(gen)) break;
      await checkPosition(p, cfg, holdings);
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
async function checkPosition(p: Position, cfg: TradeConfig, holdings: Map<string, number> | null): Promise<void> {
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

  if (cfg.mode === "live" && (await reconcile(p, cfg, holdings))) return;

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
  // above it. A Jupiter buy parks nothing anywhere, so its plan runs here like a paper one.
  // Same on a failed read, whatever the mode: `lastPrice` is stale, so only the clock is
  // still telling the truth.
  if ((p.strategyOrderId || !info) && exit.kind !== "time") return;
  const rung = /^(?:tp|rule)(\d+)$/.exec(exit.kind);
  if (rung?.[1]) p.filledRungs.push(Number(rung[1]));
  await closePosition(p, exit.percent, exit.reason);
}
