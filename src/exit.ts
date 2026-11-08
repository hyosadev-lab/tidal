import type { Config } from "./config.ts";
import { db } from "./db.ts";
import { gmgnClient } from "./gmgn/client.ts";
import * as jup from "./jupiter/client.ts";
import * as pools from "./jupiter/pools.ts";
import { log, short } from "./log.ts";
import { status } from "./control.ts";
import { bookExternal, noteSol, openPosition, openPositions, sell, type Position, type SellReason } from "./trade.ts";

/**
 * The exit loop. Prices come off each pool's reserves on-chain (`jupiter/pools.ts`): a push on
 * every change checks that position at once, and a tick every POLL_MS checks every open position
 * off the same prices — time stops, the wallet watch, the ledger write. No model on this path.
 * Jupiter's Price API is left for the USD price of SOL and other quote tokens (every QUOTE_MS)
 * and for pools the feed cannot read (every FALLBACK_MS, those mints only).
 */

export const POLL_MS = 1000;
/** A reading this many times off the last price is confirmed on GMGN before anything acts on it. */
const JUMP = 3;
/** One GMGN confirm per position per this long; in between an unconfirmed jump is no price. */
const CONFIRM_MS = 10_000;
/** A failed sell is retried after this, not on every check. */
const RETRY_MS = 15_000;
/** Live only: how often the wallet is read for sells made outside the agent, in ticks (~30s). */
const WALLET_EVERY = 30;
const QUOTE_MS = 30_000;
const FALLBACK_MS = 2_000;
/** A price older than this is no price: only the clock runs. */
const STALE_MS = 30_000;

type RuleRow = { id: number; kind: "tp" | "sl"; at_pct: number; sell_pct: number; filled_at: number | null };
export type ExitSignal = { reason: SellReason; pct: number; ruleIds: number[] };

/**
 * What to sell now, if anything. Hardest first: stops, then a liquidity drain, then the clock,
 * then take profits. When one price reaches several rules of a kind they fire together, so a
 * gap through a ladder is one sell; `ruleIds` ends with the furthest one reached. Pure.
 */
export function evaluate(
  p: Pick<Position, "opened_at" | "entry_price_usd" | "entry_liquidity_usd">,
  rules: RuleRow[],
  price: number | null,
  liquidityUsd: number | null,
  now: number,
  cfg: Pick<Config, "timeStopMinutes" | "liquidityDrainPct">,
): ExitSignal | null {
  const armed = rules.filter((r) => r.filled_at === null);
  const fire = (kind: "tp" | "sl", hit: (r: RuleRow) => boolean): ExitSignal | null => {
    const rs = armed.filter((r) => r.kind === kind && hit(r)).sort((a, b) => Math.abs(a.at_pct) - Math.abs(b.at_pct));
    return rs.length ? { reason: kind, pct: rs.reduce((t, r) => t + r.sell_pct, 0), ruleIds: rs.map((r) => r.id) } : null;
  };
  const pnl = price !== null && p.entry_price_usd > 0 ? (price / p.entry_price_usd - 1) * 100 : null;

  const stop = pnl !== null ? fire("sl", (r) => pnl <= r.at_pct) : null;
  if (stop) return stop;
  const entryLiq = p.entry_liquidity_usd ?? 0;
  if (liquidityUsd !== null && entryLiq > 0 && liquidityUsd < entryLiq * (1 - cfg.liquidityDrainPct / 100))
    return { reason: "health", pct: 100, ruleIds: [] };
  if (now - p.opened_at >= cfg.timeStopMinutes * 60_000) return { reason: "time", pct: 100, ruleIds: [] };
  return pnl !== null ? fire("tp", (r) => pnl >= r.at_pct) : null;
}

// ── prices ────────────────────────────────────────────────────────────

export type Px = { usd: number; liquidityUsd: number | null; at: number; source: "pool" | "Jupiter" };

/** USD per quote token (SOL, PUMP, …) and Jupiter's price for the mints the pool feed cannot read. */
const usdOf = new Map<string, number>();
const jupPx = new Map<string, Px>();
let jupAt = 0;
let priceDown = false;

/**
 * The pool feed's price, else Jupiter's; null once older than STALE_MS. Pure. Liquidity is the
 * pool's quote reserve only: Jupiter's figure counts the whole pool (2–4× that), so a baseline
 * taken off it read as a drain the moment the pool feed came in.
 */
export function pickPrice(r: pools.Reading | null, usd: number | undefined, fallback: Px | undefined, now: number): Px | null {
  const px = r && usd ? { usd: r.price * usd, liquidityUsd: r.liquidity * usd, at: r.at, source: "pool" as const } : fallback ? { ...fallback, liquidityUsd: null } : null;
  return px && now - px.at <= STALE_MS ? px : null;
}

const priceOf = (mint: string, now: number): Px | null => {
  const r = pools.reading(mint);
  return pickPrice(r, r ? usdOf.get(r.quoteMint) : undefined, jupPx.get(mint), now);
};

/** One Jupiter read when due: quote-token USD every QUOTE_MS, every FALLBACK_MS while a mint needs it. */
async function jupiterRead(open: Position[]): Promise<void> {
  const now = Date.now();
  const quotes = pools.quoteMints();
  const fallback = open.map((p) => p.token).filter((m) => !pools.reading(m));
  if (now - jupAt < (fallback.length || quotes.some((q) => !usdOf.has(q)) ? FALLBACK_MS : QUOTE_MS)) return;
  jupAt = now;
  try {
    const m = await jup.prices([...new Set([jup.WSOL, ...quotes, ...fallback])]);
    noteSol(m.get(jup.WSOL)?.usd);
    for (const q of [jup.WSOL, ...quotes]) {
      const usd = m.get(q)?.usd;
      if (usd) usdOf.set(q, usd);
    }
    jupPx.clear();
    for (const f of fallback) {
      const v = m.get(f);
      if (v) jupPx.set(f, { usd: v.usd, liquidityUsd: v.liquidityUsd, at: now, source: "Jupiter" });
    }
    if (priceDown) log("info", "Jupiter prices are back.");
    priceDown = false;
  } catch (e) {
    if (!priceDown) log("warn", `Jupiter price read failed: ${short(e)} — pools keep their on-chain price; the rest run time stops only.`);
    priceDown = true;
  }
}

// ── the pool feed ─────────────────────────────────────────────────────

/** Where a token trades, when its curve completed while it was held: GMGN's answer. */
const movedTo = new Map<string, string>();
const askedMove = new Set<string>();
const toldOff = new Set<string>();

function poolOf(token: string): string | null {
  const moved = movedTo.get(token);
  if (moved) return moved;
  const r = db
    .prepare("select pool_address from token_snapshots where token = ? and pool_address is not null order by taken_at desc limit 1")
    .get(token) as { pool_address: string } | undefined;
  return r?.pool_address ?? null;
}

/** The feed watches exactly the open positions' pools. */
function syncFeed(open: Position[]): void {
  const want = new Map(open.map((p) => [p.token, p.symbol]));
  for (const m of pools.watching()) if (!want.has(m)) pools.unwatch(m);
  for (const [m, symbol] of want) {
    const pool = poolOf(m);
    if (pool) void pools.watch(m, pool);
    const off = pool ? pools.offReason(m) : "no pool address on record";
    if (off === "curve complete" && !askedMove.has(m)) void findMovedPool(m);
    if (off && !toldOff.has(m)) log("info", `${symbol}: priced on Jupiter — ${off}.`);
    if (off) toldOff.add(m);
    else toldOff.delete(m);
  }
}

async function findMovedPool(mint: string): Promise<void> {
  askedMove.add(mint);
  try {
    const pool = (await gmgnClient().getTokenInfo("sol", mint) as any)?.pool?.pool_address;
    if (typeof pool === "string" && pool) movedTo.set(mint, pool);
  } catch {
    /* stays on Jupiter */
  }
}

// ── checks ────────────────────────────────────────────────────────────

/** Open positions as the last tick read them; pushes update their prices in between. */
const held = new Map<number, Position>();
let cfgNow: Config | null = null;
let tickAt = 0;
const busy = new Set<number>();
const confirmAt = new Map<number, number>();
const retryAt = new Map<number, number>();
let ticking = false;
let ticks = 0;
let socketWas = false;

// A price move checks every position in that mint at once — only while the tick runs (Running).
pools.feed.addEventListener("price", (e) => {
  const mint = (e as CustomEvent<string>).detail;
  const now = Date.now();
  if (!cfgNow || now - tickAt > 3 * POLL_MS) return;
  for (const p of held.values()) if (p.token === mint) void check(p, cfgNow, now, false);
});

async function gmgnPrice(mint: string): Promise<number | null> {
  try {
    const info: any = await gmgnClient().getTokenInfo("sol", mint);
    const v = Number(info?.price?.price);
    return v > 0 ? v : null;
  } catch {
    return null;
  }
}

/**
 * Live: tokens that left the wallet without this process selling them are booked as `external`.
 * A position under a minute old is left alone — an RPC read that trails the buy would read as a sale.
 */
async function walletWatch(p: Position): Promise<void> {
  if (p.mode !== "live" || !p.wallet || Date.now() - p.opened_at < 60_000) return;
  try {
    await bookExternal(p.id, await jup.tokenBalance(p.wallet, p.token));
  } catch (e) {
    log("warn", `Wallet read for ${p.symbol} failed: ${short(e)}`);
  }
}

/** One position against its rules. One at a time per position; `persist` (the tick) writes the prices. */
async function check(p: Position, cfg: Config, now: number, persist: boolean): Promise<void> {
  if (busy.has(p.id)) return;
  busy.add(p.id);
  try {
    const px = priceOf(p.token, now);
    let price = px?.usd ?? null;
    const last = p.last_price_usd;
    if (px && price !== null && last && (price > last * JUMP || price * JUMP < last)) {
      if (now - (confirmAt.get(p.id) ?? 0) < CONFIRM_MS) price = null;
      else {
        confirmAt.set(p.id, now);
        const confirmed = await gmgnPrice(p.token);
        log("warn", `${p.symbol}: ${px.source} $${price.toPrecision(4)} vs last $${last.toPrecision(4)} — GMGN says ${confirmed ? `$${confirmed.toPrecision(4)}` : "nothing"}.`);
        price = confirmed;
      }
    }
    if (price !== null) {
      p.last_price_usd = price;
      p.peak_price_usd = Math.max(p.peak_price_usd ?? price, price);
    }
    if (persist) db.prepare("update positions set last_price_usd = ?, peak_price_usd = ? where id = ?").run(p.last_price_usd, p.peak_price_usd, p.id);
    // The first liquidity reading after the buy is the baseline the health check measures from.
    if (p.entry_liquidity_usd === null && px?.liquidityUsd) {
      p.entry_liquidity_usd = px.liquidityUsd;
      db.prepare("update positions set entry_liquidity_usd = ? where id = ?").run(px.liquidityUsd, p.id);
    }

    const rules = db.prepare("select id, kind, at_pct, sell_pct, filled_at from exit_rules where position_id = ? order by seq").all(p.id) as RuleRow[];
    const exit = evaluate(p, rules, price, px?.liquidityUsd ?? null, now, cfg);
    if (!exit || now < (retryAt.get(p.id) ?? 0)) return;
    if (!openPosition(p.id)) return void held.delete(p.id); // closed since the last tick
    const err = await sell(p.id, exit.pct, exit.reason, exit.ruleIds);
    if (err) {
      retryAt.set(p.id, now + RETRY_MS);
      log("warn", `Sell ${p.symbol} (${exit.reason}) failed: ${err} — retrying in ${RETRY_MS / 1000}s.`);
    } else retryAt.delete(p.id);
  } catch (e) {
    retryAt.set(p.id, now + RETRY_MS);
    log("error", `Exit check ${p.symbol} errored: ${short(e)}`);
  } finally {
    busy.delete(p.id);
  }
}

/** One tick. Skipped while the last is still running, so a slow sell never stacks or runs twice. */
export async function exitTick(cfg: Config): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    let open = openPositions();
    status.exit.lastAt = tickAt = Date.now();
    cfgNow = cfg;
    syncFeed(open);
    pools.tick();
    const up = pools.socketUp();
    if (up !== socketWas && open.length)
      log(up ? "info" : "warn", up ? "Pool price socket is up." : "Pool price socket is down — reading pools every 1s until it is back.");
    socketWas = up;
    if (open.length && ++ticks % WALLET_EVERY === 0) {
      for (const p of open) await walletWatch(p);
      open = openPositions();
    }
    await jupiterRead(open);
    // The ledger has the prices as of the last tick; pushes since then live in `held`.
    const before = new Map(held);
    held.clear();
    for (const p of open) {
      const q = before.get(p.id);
      if (q) {
        p.last_price_usd = q.last_price_usd;
        p.peak_price_usd = Math.max(p.peak_price_usd ?? 0, q.peak_price_usd ?? 0) || null;
      }
      held.set(p.id, p);
    }
    const now = Date.now();
    for (const p of open) await check(p, cfg, now, true);
    const onChain = open.filter((p) => pools.reading(p.token)).length;
    const blind = open.filter((p) => !priceOf(p.token, Date.now())).length;
    Object.assign(status.exit, { mints: open.length, socket: up, onChain, onJupiter: open.length - onChain, priceError: blind ? `${blind} without a fresh price` : "" });
  } catch (e) {
    log("error", `Exit tick failed: ${short(e)}`);
  } finally {
    ticking = false;
  }
}

/** While stopped: nothing is watched, so the socket closes. */
export function exitIdle(): void {
  for (const m of pools.watching()) pools.unwatch(m);
  pools.tick();
  held.clear();
  cfgNow = null;
}
