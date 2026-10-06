import { DUST_FRACTION, evaluateExit, healthExit, isDust } from "../domain/positions.ts";
import { num, short } from "../domain/num.ts";
import { store } from "../data/store.ts";
import * as broker from "../market/broker.ts";
import * as gmgn from "../market/gmgn.ts";
import * as helius from "../market/helius.ts";
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
 * on itself. A Jupiter-bought one (Solana) has nothing on anyone else's side: Jupiter is only the
 * swap, so its whole plan runs here, exactly as in paper — and stops running if this process does.
 *
 * Between ticks a Solana position on a pool `helius` can read is also priced on every swap
 * (`onStreamPrice`), and the same plan is run against that price the moment it arrives. The tick
 * is still the whole loop for everything else: the wallet mirror, the health exit, the time stop.
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
 * index is not asked: it trails the chain, and a stale zero there would book a position that
 * was just bought as sold.
 */
async function walletQty(p: Position, cfg: TradeConfig): Promise<number | undefined> {
  try {
    return Number(await jupiter.tokenBalance(cfg.walletAddress, p.address)) / 10 ** p.decimals!;
  } catch (e) {
    store.log("warn", `Wallet balance read failed for ${p.symbol}: ${short(e)} — not mirrored this tick.`);
    return undefined;
  }
}

/** Only one tick runs at a time — a slow book must not overlap the next interval. */
let monitoring = false;

// ── streamed prices ───────────────────────────────────────────────────

/**
 * One per position that was offered to the stream. `new` until a streamed price has agreed with
 * a GMGN read once — the pool arithmetic is reverse-engineered, and a wrong price here is a real
 * sell — then `on`. `off` is a stream that disagreed: left alone for the life of the position.
 */
type Stream = { price: number; at: number; state: "new" | "on" | "off" };
const streams = new Map<string, Stream>(); // by token address
/** A streamed price this recent outranks GMGN's, which is the older of the two. */
const STREAM_FRESH_MS = 15_000;
/** How far a first streamed price may sit from GMGN's and still be the same price. */
const STREAM_AGREES = 0.2;
let solUsd = 0;
let pushedAt = 0;

const streaming = (p: Position): boolean => {
  const s = streams.get(p.address);
  return s?.state === "on" && Date.now() - s.at < STREAM_FRESH_MS;
};

/** Every stream closed — Stop means nothing here sells, and a stream would. */
export function stopStreams(): void {
  for (const a of streams.keys()) helius.unwatch(a);
  streams.clear();
}

/** Starts a stream for a position that has none yet, and settles whether a new one can be trusted. */
function syncStream(p: Position, info: Record<string, any> | null, gmgnPrice: number): void {
  // A tick still in flight when Stop landed must not reopen what `stopStreams` just closed.
  if (p.chain !== "sol" || !helius.enabled() || store.runState === "stopped") return;
  const s = streams.get(p.address);
  if (!s) {
    const ref = helius.poolRef(info);
    if (!ref) return;
    streams.set(p.address, { price: 0, at: 0, state: "new" });
    helius.watch(p.address, ref, (sol) => void onStreamPrice(p.address, sol));
    return;
  }
  if (s.state !== "new" || !(gmgnPrice > 0) || Date.now() - s.at > STREAM_FRESH_MS) return;
  if (Math.abs(s.price / gmgnPrice - 1) < STREAM_AGREES) {
    s.state = "on";
    store.log("info", `${p.symbol}: live price stream on — exits now run on every swap, not every tick.`);
  } else {
    s.state = "off";
    helius.unwatch(p.address);
    store.log("warn", `${p.symbol}: streamed price $${s.price.toPrecision(4)} disagrees with GMGN's $${gmgnPrice.toPrecision(4)} — stream off, exits stay on the ${store.config.monitorSeconds}s tick.`);
  }
}

/** One swap in a watched pool. Prices the position, and runs its plan unless a tick is already at it. */
async function onStreamPrice(address: string, sol: number): Promise<void> {
  const p = store.position(address);
  const s = streams.get(address);
  if (!p || !s || s.state === "off" || !(solUsd > 0)) return;
  s.price = sol * solUsd;
  s.at = Date.now();
  if (s.state !== "on") return;
  p.lastPrice = s.price;
  p.peakPrice = Math.max(p.peakPrice, s.price);
  if (Date.now() - pushedAt > 2000) {
    pushedAt = Date.now();
    store.push();
  }
  // A tick in flight reads this same `lastPrice` when it reaches the plan, so nothing is lost.
  if (monitoring) return;
  monitoring = true;
  try {
    await runPlan(p, store.config, true);
  } catch (e) {
    store.log("error", `Stream exit for ${p.symbol} failed: ${short(e)}`);
  } finally {
    monitoring = false;
  }
}

export async function runMonitor(): Promise<void> {
  // A closed position's stream goes with it — before the early return, or the last one never would.
  for (const a of streams.keys())
    if (!store.position(a)) {
      streams.delete(a);
      helius.unwatch(a);
    }
  if (monitoring || !store.positions.length) return;
  monitoring = true;
  const gen = generation();
  try {
    const cfg = store.config;
    // What turns a streamed SOL price into dollars. Same 30s cache every buy and paper leg reads.
    if (cfg.chain === "sol" && helius.enabled()) solUsd = await gmgn.nativeUsdPrice(cfg.chain).catch(() => solUsd);
    // One read for the whole wallet, before anything else: in live mode GMGN's copy of the
    // book is the real one, and every position below is checked against it.
    // Positions that know their decimals are read off the chain instead, one read each.
    const live = cfg.mode === "live";
    const holdings = live && store.positions.some((p) => p.decimals == null) ? await readHoldings(cfg) : null;

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
async function checkPosition(
  p: Position,
  cfg: TradeConfig,
  holdings: Map<string, number> | null,
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
  syncStream(p, info, price);
  if (price > 0 && !streaming(p)) {
    p.lastPrice = price;
    p.peakPrice = Math.max(p.peakPrice, price);
  }

  if (cfg.mode === "live") {
    if (await reconcile(p, cfg, p.decimals != null ? await walletQty(p, cfg) : holdings?.get(p.address.toLowerCase()))) return;
  }

  const health = healthExit(p, info ?? {});
  if (health) {
    await closePosition(p, health.percent, health.reason);
    return;
  }

  await runPlan(p, cfg, !!info || streaming(p));
}

/** The exit plan against `lastPrice`. `priced` is false when that price is stale, and then only the clock is believed. */
async function runPlan(p: Position, cfg: TradeConfig, priced: boolean): Promise<void> {
  const exit = evaluateExit(p, cfg);
  if (!exit) return;
  // A position bought through GMGN carries its whole plan on GMGN's side (`strategyOrderId`),
  // so acting on a price rule here would be a second sell for an exit that is already placed.
  // What is left is the two things GMGN was never told: the time stop, and the health exit
  // the tick runs before this. A Jupiter position has no such order, so its plan runs here like
  // a paper one. Same on a stale price, whatever the mode: only the clock is still telling
  // the truth.
  if ((p.strategyOrderId || !priced) && exit.kind !== "time") return;
  const rung = /^(?:tp|rule)(\d+)$/.exec(exit.kind);
  if (rung?.[1]) p.filledRungs.push(Number(rung[1]));
  await closePosition(p, exit.percent, exit.reason);
}
