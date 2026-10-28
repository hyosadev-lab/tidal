import type { Config, Rule } from "./config.ts";
import { db, insert, tx } from "./db.ts";
import { gmgnClient } from "./gmgn/client.ts";
import * as jup from "./jupiter/client.ts";
import { log, short } from "./log.ts";
import { takeSnapshot } from "./snapshot.ts";

/**
 * Everything that moves funds, and the books it leaves. Paper fills on a live Jupiter quote —
 * real route, price impact and fee, nothing sent; live swaps through Jupiter, signed in-process
 * with SOLANA_PRIVATE_KEY. Raw token amounts stay bigint strings end to end.
 */

/** Fires "close" when a position closes: a slot is free, so the idle entry loop wakes. */
export const positionClosed = new EventTarget();

/** SOL kept in a live wallet for fees; never spent on a buy. */
const GAS_RESERVE_SOL = 0.02;
/** A buy under this many USD is refused — fees would eat it. */
export const MIN_BUY_USD = 3;

// ── prices ────────────────────────────────────────────────────────────

let sol = { usd: 0, at: 0 };

/**
 * USD per SOL, cached 30s; the exit loop refreshes it on every poll through `noteSol`. When a
 * fresh read fails the last known price stands in: a stale SOL price beats a stop that cannot sell.
 */
export async function solUsd(): Promise<number> {
  if (Date.now() - sol.at < 30_000 && sol.usd > 0) return sol.usd;
  const usd = await jup
    .prices([jup.WSOL])
    .then((m) => m.get(jup.WSOL)?.usd ?? 0)
    .catch(() => 0);
  if (usd > 0) sol = { usd, at: Date.now() };
  if (!(sol.usd > 0)) throw new Error("no SOL price from Jupiter");
  return sol.usd;
}

/** The last SOL price seen, 0 before the first. For display only. */
export const lastSolUsd = (): number => sol.usd;

export const noteSol = (usd: number | undefined): void => {
  if (usd && usd > 0) sol = { usd, at: Date.now() };
};

// ── security ──────────────────────────────────────────────────────────

const truthy = (v: unknown) => v === true || v === 1 || v === "1" || v === "true" || v === "yes";
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * GMGN /v1/token/security → why this token must not be bought, or "" to pass. Fields verified
 * live: renounced_mint / renounced_freeze_account booleans, burn_status "burn" / burn_ratio,
 * buy_tax / sell_tax "0", honeypot / can_not_sell 0|1. Unknown is not a pass.
 */
export function securityRisk(sec: any): string {
  if (!sec || typeof sec !== "object") return "could not read token security";
  const r: string[] = [];
  const tax = Math.max(num(sec.buy_tax), num(sec.sell_tax));
  if (tax > 0.1) r.push(`tax ${Math.round(tax * 100)}%`);
  if (sec.renounced_mint === undefined && sec.renounced_freeze_account === undefined) r.push("no renounce status");
  else {
    if (!truthy(sec.renounced_mint)) r.push("mint authority still live");
    if (!truthy(sec.renounced_freeze_account)) r.push("freeze authority still live");
  }
  if (String(sec.burn_status ?? "").toLowerCase() !== "burn" && !(num(sec.burn_ratio) > 0)) r.push("liquidity not burned");
  if (truthy(sec.is_honeypot) || truthy(sec.honeypot) || truthy(sec.can_not_sell)) r.push("cannot sell");
  return r.join(", ");
}

export async function security(mint: string): Promise<string> {
  return securityRisk(await gmgnClient().getTokenSecurity("sol", mint));
}

// ── the books ─────────────────────────────────────────────────────────

export type Position = {
  id: number;
  token: string;
  symbol: string;
  decimals: number;
  mode: "paper" | "live";
  wallet: string | null;
  opened_at: number;
  entry_price_usd: number;
  cost_usd: number;
  original_qty: string;
  qty: string;
  entry_liquidity_usd: number | null;
  last_price_usd: number | null;
  peak_price_usd: number | null;
};

const POSITION = `select p.*, coalesce(t.symbol, substr(p.token, 1, 6)) symbol, t.decimals from positions p
  join tokens t on t.address = p.token where p.status = 'open'`;

export function openPositions(): Position[] {
  return db.prepare(`${POSITION} order by p.id`).all() as Position[];
}

export function openPosition(id: number): Position | undefined {
  return db.prepare(`${POSITION} and p.id = ?`).get(id) as Position | undefined;
}

/** settings.paperStartUsd + Σ sells − Σ buys, over paper positions. */
export function paperCash(cfg: Config): number {
  const r = db
    .prepare(
      `select coalesce(sum(case t.side when 'sell' then t.usd else -t.usd end), 0) net
       from trades t join positions p on p.id = t.position_id where p.mode = 'paper'`,
    )
    .get() as { net: number };
  return cfg.paperStartUsd + r.net;
}

/** USD to deploy: paper cash, or the live wallet's SOL above the gas reserve. */
export async function cashUsd(cfg: Config): Promise<number> {
  if (cfg.mode === "paper") return paperCash(cfg);
  const wallet = jup.address();
  const bal = wallet ? await jup.solBalance(wallet) : null;
  if (bal === null) throw new Error("could not read the wallet's SOL balance");
  return Math.max(0, bal - GAS_RESERVE_SOL) * (await solUsd());
}

const value = (p: Position) => (Number(p.qty) / 10 ** p.decimals) * (p.last_price_usd ?? p.entry_price_usd);

/** One equity row: cash plus open positions at their last price. Called about once a minute. */
export async function sampleEquity(cfg: Config): Promise<void> {
  const cash = await cashUsd(cfg);
  const held = openPositions().reduce((t, p) => t + value(p), 0);
  db.prepare("insert or replace into equity (at, equity_usd, cash_usd) values (?, ?, ?)").run(Date.now(), cash + held, cash);
}

/** The start of the daily-loss day: 00:00 UTC, whatever zone the server or the viewer is in. */
export const lossDay = (now: number) => now - (now % 86_400_000);

/**
 * Whether today's loss has passed maxDailyLossPct of the day's starting equity, off the sampled
 * equity rows. The day starts at 00:00 UTC (`lossDay`), so buying resumes on its own then.
 */
export function buyingPaused(cfg: Config, now = Date.now()): boolean {
  const midnight = lossDay(now);
  const start = (db.prepare("select equity_usd e from equity where at >= ? order by at limit 1").get(midnight) ??
    db.prepare("select equity_usd e from equity where at < ? order by at desc limit 1").get(midnight)) as { e: number } | undefined;
  const last = db.prepare("select equity_usd e from equity order by at desc limit 1").get() as { e: number } | undefined;
  return !!start && !!last && start.e > 0 && ((last.e - start.e) / start.e) * 100 <= -cfg.maxDailyLossPct;
}

// ── buy ───────────────────────────────────────────────────────────────

/** Buys cfg.sizeSol of `token` and books the position with its exit plan. Returns an error, or null. */
export async function buy(o: { token: string; decisionId: number; entrySnapshotId: number; plan: Rule[]; cfg: Config }): Promise<string | null> {
  const { token, cfg } = o;
  const t = db.prepare("select symbol, decimals from tokens where address = ?").get(token) as { symbol: string | null; decimals: number | null };
  const snap = db.prepare("select price_usd, market_cap_usd from token_snapshots where id = ?").get(o.entrySnapshotId) as {
    price_usd: number;
    market_cap_usd: number | null;
  };
  const symbol = t.symbol ?? token.slice(0, 6);
  const solPrice = await solUsd();
  const decimals = t.decimals ?? (await jup.decimals(token));
  const lamports = String(Math.round(cfg.sizeSol * 1e9));

  let qtyRaw: string;
  let costUsd: number;
  let signature: string | null = null;
  let wallet: string | null = null;
  let friction: number | null = null; // what the buy paid over the market price; the sell pays about as much again
  if (cfg.mode === "paper") {
    const q = await jup.quote({ inputMint: jup.WSOL, outputMint: token, amount: lamports, slippagePct: cfg.slippagePct });
    if ("error" in q) return q.error;
    qtyRaw = q.outAmount;
    costUsd = q.inUsd || cfg.sizeSol * solPrice;
    if (q.inUsd > 0 && q.outUsd > 0) friction = 1 - q.outUsd / q.inUsd;
  } else {
    wallet = jup.address();
    if (!wallet) return "live mode needs SOLANA_PRIVATE_KEY";
    const fill = await jup.swap({ inputMint: jup.WSOL, outputMint: token, amount: lamports, slippagePct: cfg.slippagePct });
    if ("error" in fill) return fill.error;
    qtyRaw = fill.outAmount;
    costUsd = (Number(fill.inAmount) / 1e9) * solPrice;
    signature = fill.signature;
  }
  const qty = Number(qtyRaw) / 10 ** decimals;
  if (!(qty > 0) || !/^\d+$/.test(qtyRaw)) return `swap returned no output (${qtyRaw})`;
  const entryPrice = costUsd / qty;
  // Live has no USD values off /execute: measured against GMGN's market price instead.
  friction = Math.min(0.9, Math.max(0, friction ?? 1 - snap.price_usd / entryPrice));
  const liquidity = (await jup.prices([token]).catch(() => new Map<string, jup.Price>())).get(token)?.liquidityUsd ?? null;

  try {
    tx(() => {
      if (t.decimals === null) db.prepare("update tokens set decimals = ? where address = ?").run(decimals, token);
      const positionId = insert("positions", {
        token,
        decision_id: o.decisionId,
        entry_snapshot_id: o.entrySnapshotId,
        mode: cfg.mode,
        wallet,
        status: "open",
        opened_at: Date.now(),
        entry_price_usd: entryPrice,
        cost_usd: costUsd,
        original_qty: qtyRaw,
        qty: qtyRaw,
        breakeven_pct: (1 / (1 - friction) - 1) * 100,
        entry_liquidity_usd: liquidity,
        entry_market_cap_usd: snap.market_cap_usd !== null ? (snap.market_cap_usd * entryPrice) / snap.price_usd : null,
        last_price_usd: snap.price_usd,
        peak_price_usd: snap.price_usd,
      });
      insert("trades", {
        position_id: positionId,
        at: Date.now(),
        side: "buy",
        qty: qtyRaw,
        price_usd: entryPrice,
        usd: costUsd,
        reason: "entry",
        tx_signature: signature,
      });
      o.plan.forEach((r, seq) => insert("exit_rules", { position_id: positionId, seq, kind: r.kind, at_pct: r.at, sell_pct: r.sell }));
    });
  } catch (e) {
    // The swap is irreversible; a booking that fails after it leaves tokens in the wallet unbooked.
    log("error", `BUY ${symbol} filled${signature ? ` (${signature})` : ""} but booking failed: ${short(e)} — check the wallet by hand.`);
    return "booked nothing";
  }
  log("trade", `BUY ${symbol} $${costUsd.toFixed(2)} at $${entryPrice.toPrecision(4)} (${cfg.mode})`, signature ?? undefined);
  return null;
}

// ── sell ──────────────────────────────────────────────────────────────

export type SellReason = "tp" | "sl" | "time" | "health" | "manual";

// Every sell and every external booking runs one at a time, against the position as it is in the
// ledger right then: the exit loop, a Close from the dashboard and Close all can never sell the
// same tokens twice.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

/**
 * Sells `pct` of the position's ORIGINAL qty (capped at what is left), records the fill with its
 * realised PnL, marks `ruleIds` filled, and closes the position when what is left is dust.
 * Returns an error, or null. A failed sell changes nothing, so the next event retries it.
 */
export function sell(positionId: number, pct: number, reason: SellReason, ruleIds: number[] = []): Promise<string | null> {
  return serial(async () => {
    const p = openPosition(positionId);
    return p ? sellNow(p, pct, reason, ruleIds) : "the position is already closed";
  });
}

/** Live: books what left the wallet without this process selling it, at the last price. */
export function bookExternal(positionId: number, held: bigint): Promise<void> {
  return serial(async () => {
    const p = openPosition(positionId);
    if (!p) return;
    const gone = BigInt(p.qty) - held;
    if (gone * 100n <= BigInt(p.original_qty)) return; // within 1%: rounding, not a sale
    const price = p.last_price_usd ?? p.entry_price_usd;
    recordSell(p, gone, (Number(gone) / 10 ** p.decimals) * price, "external", [], null);
  });
}

async function sellNow(p: Position, pct: number, reason: SellReason, ruleIds: number[]): Promise<string | null> {
  const original = BigInt(p.original_qty);
  const held = BigInt(p.qty);
  let want = (original * BigInt(Math.round(pct * 100))) / 10_000n;
  if (want > held) want = held;
  if (want <= 0n) return "nothing left to sell";

  let soldRaw = want;
  let usd: number;
  let signature: string | null = null;
  if (p.mode === "paper") {
    const q = await jup.quote({ inputMint: p.token, outputMint: jup.WSOL, amount: want.toString(), slippagePct: 0 });
    if ("error" in q) return q.error;
    usd = q.outUsd || (Number(q.outAmount) / 1e9) * (await solUsd());
  } else {
    if (!p.wallet || p.wallet !== jup.address()) return `SOLANA_PRIVATE_KEY does not sign for ${p.wallet}`;
    const bal = await jup.tokenBalance(p.wallet, p.token);
    if (bal < soldRaw) soldRaw = bal;
    if (soldRaw <= 0n) return "the wallet holds none of this token";
    // Slippage 0 = Jupiter picks the tolerance: on an exit, a stop that refuses to fill costs more than slippage.
    const fill = await jup.swap({ inputMint: p.token, outputMint: jup.WSOL, amount: soldRaw.toString(), slippagePct: 0 });
    if ("error" in fill) return fill.error;
    usd = (Number(fill.outAmount) / 1e9) * (await solUsd());
    signature = fill.signature;
  }
  recordSell(p, soldRaw, usd, reason, ruleIds, signature);
  return null;
}

/** Books a sell that already happened: here, or outside the agent (`external`, at the last price). */
function recordSell(
  p: Position,
  soldRaw: bigint,
  usd: number,
  reason: SellReason | "external",
  ruleIds: number[],
  signature: string | null,
): void {
  const original = BigInt(p.original_qty);
  const left = BigInt(p.qty) - soldRaw;
  const basis = (p.cost_usd * Number(soldRaw)) / Number(original);
  const pnl = usd - basis;
  const now = Date.now();
  const closes = left * 100n <= original; // ≤ 1% left is dust
  tx(() => {
    insert("trades", {
      position_id: p.id,
      exit_rule_id: ruleIds.at(-1) ?? null,
      at: now,
      side: "sell",
      qty: soldRaw.toString(),
      price_usd: usd / (Number(soldRaw) / 10 ** p.decimals),
      usd,
      pnl_usd: pnl,
      reason,
      tx_signature: signature,
    });
    db.prepare("update positions set qty = ? where id = ?").run((left < 0n ? 0n : left).toString(), p.id);
    for (const id of ruleIds) db.prepare("update exit_rules set filled_at = ? where id = ?").run(now, id);
    if (closes) db.prepare("update positions set status = 'closed', closed_at = ?, close_reason = ? where id = ?").run(now, reason, p.id);
  });
  const pctSold = Math.round((Number(soldRaw) / Number(original)) * 100);
  log("trade", `SELL ${p.symbol} ${pctSold}% $${usd.toFixed(2)} · PnL ${pnl >= 0 ? "+" : "−"}$${Math.abs(pnl).toFixed(2)} · ${reason}${closes ? " · closed" : ""}`, signature ?? undefined);
  if (closes) positionClosed.dispatchEvent(new Event("close"));
  if (closes)
    void takeSnapshot(p.token, "exit")
      .then((id) => db.prepare("update positions set exit_snapshot_id = ? where id = ?").run(id, p.id))
      .catch(() => {}); // what it looked like at the close is nice to have, not worth a retry
}
