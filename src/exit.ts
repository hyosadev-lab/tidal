import type { Config } from "./config.ts";
import { db } from "./db.ts";
import { gmgnClient } from "./gmgn/client.ts";
import * as jup from "./jupiter/client.ts";
import { log, short } from "./log.ts";
import { status } from "./control.ts";
import { bookExternal, noteSol, openPosition, openPositions, sell, type Position, type SellReason } from "./trade.ts";

/**
 * The exit loop: every POLL_MS one Jupiter Price API read prices every open position, and each
 * is checked against its exit rules, the health check and the time stop. No model on this path.
 * (The board's Helius swap stream needs a paid Helius plan; this poll stands in for it.)
 */

export const POLL_MS = 3000;
/** A reading this many times off the last price is confirmed on GMGN before anything acts on it. */
const JUMP = 3;
/** A failed sell is retried after this, not on every poll. */
const RETRY_MS = 15_000;
/** Live only: how often the wallet is read for sells made outside the agent, in polls. */
const WALLET_EVERY = 10;

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

const retryAt = new Map<number, number>();
let polling = false;
let polls = 0;
let priceDown = false;

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

async function check(at: Position, cfg: Config, px: jup.Price | undefined, now: number): Promise<void> {
  let p = at;
  let price = px?.usd ?? null;
  const last = p.last_price_usd;
  if (price !== null && last && (price > last * JUMP || price * JUMP < last)) {
    const confirmed = await gmgnPrice(p.token);
    log("warn", `${p.symbol}: Jupiter $${price.toPrecision(4)} vs last $${last.toPrecision(4)} — GMGN says ${confirmed ? `$${confirmed.toPrecision(4)}` : "nothing"}.`);
    price = confirmed;
  }
  if (price !== null) {
    p.last_price_usd = price;
    p.peak_price_usd = Math.max(p.peak_price_usd ?? price, price);
    db.prepare("update positions set last_price_usd = ?, peak_price_usd = ? where id = ?").run(price, p.peak_price_usd, p.id);
  }
  // A position booked while Jupiter had no liquidity figure takes its first one as the baseline.
  if (p.entry_liquidity_usd === null && px?.liquidityUsd) {
    p.entry_liquidity_usd = px.liquidityUsd;
    db.prepare("update positions set entry_liquidity_usd = ? where id = ?").run(px.liquidityUsd, p.id);
  }
  if (polls % WALLET_EVERY === 0) {
    await walletWatch(p);
    const fresh = openPosition(p.id);
    if (!fresh) return;
    p = { ...fresh, last_price_usd: p.last_price_usd, peak_price_usd: p.peak_price_usd, entry_liquidity_usd: p.entry_liquidity_usd };
  }

  const rules = db.prepare("select id, kind, at_pct, sell_pct, filled_at from exit_rules where position_id = ? order by seq").all(p.id) as RuleRow[];
  const exit = evaluate(p, rules, price, px?.liquidityUsd ?? null, now, cfg);
  if (!exit || now < (retryAt.get(p.id) ?? 0)) return;
  try {
    const err = await sell(p.id, exit.pct, exit.reason, exit.ruleIds);
    if (err) {
      retryAt.set(p.id, now + RETRY_MS);
      log("warn", `Sell ${p.symbol} (${exit.reason}) failed: ${err} — retrying in ${RETRY_MS / 1000}s.`);
    } else retryAt.delete(p.id);
  } catch (e) {
    retryAt.set(p.id, now + RETRY_MS);
    log("error", `Sell ${p.symbol} (${exit.reason}) errored: ${short(e)}`);
  }
}

/** One poll. Skipped while the last is still running, so a slow sell never stacks or runs twice. */
export async function exitTick(cfg: Config): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    const open = openPositions();
    status.exit.lastAt = Date.now();
    status.exit.mints = open.length;
    if (!open.length) return;
    polls++;
    let prices = new Map<string, jup.Price>();
    try {
      prices = await jup.prices([...open.map((p) => p.token), jup.WSOL]);
      noteSol(prices.get(jup.WSOL)?.usd);
      if (priceDown) log("info", "Jupiter prices are back.");
      priceDown = false;
      status.exit.priceError = "";
    } catch (e) {
      // No prices: only the clock still runs this poll.
      if (!priceDown) log("warn", `Jupiter price read failed: ${short(e)} — only time stops run until it is back.`);
      priceDown = true;
      status.exit.priceError = short(e);
    }
    const now = Date.now();
    for (const p of open) await check(p, cfg, prices.get(p.token), now);
  } catch (e) {
    log("error", `Exit poll failed: ${short(e)}`);
  } finally {
    polling = false;
  }
}
