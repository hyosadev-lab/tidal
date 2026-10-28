import { inFilters, loadConfig, rankFilters, signalFilters, type Config } from "./config.ts";
import { lossPaused, status, type FeedRow } from "./control.ts";
import { db, insert, tx } from "./db.ts";
import { decide, type Verdict } from "./decide.ts";
import { gmgnClient } from "./gmgn/client.ts";
import * as jup from "./jupiter/client.ts";
import { log, short } from "./log.ts";
import { takeSnapshot, writeSignal } from "./snapshot.ts";
import { buy, cashUsd, MIN_BUY_USD, openPositions, security, solUsd } from "./trade.ts";

/**
 * The entry loop, once per CYCLE_MS: fetch → keep what is due → snapshot it → one agent run →
 * save verdicts → risk check and buy, best conviction first. Skip is final, a wait returns when
 * its time is up, a token bought and sold returns after the cooldown.
 */

export const CYCLE_MS = 60_000;
/** Due tokens per agent run, at most; the rest stay due for the next cycle. */
const MAX_BRIEF = 10;
const FEED_LIMIT = 40;
/**
 * One group each, as GMGN returns at most 50 rows a group: smart-money buy, KOL buy, price (spike,
 * all-time high, market-cap key level), community takeover. The warnings (bundler sell, pump
 * claim) are not fetched: every row's signal_times_by_type already counts them for the brief.
 */
const SIGNAL_GROUPS = [[12], [20], [6, 7, 8], [11]];

const num = (v: unknown): number | null => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * GMGN 1h trending + signal, in that order, deduped; each row kept with the feed's own numbers
 * for the dashboard. Field names verified on live rows: the signal route carries no price change,
 * and its 1h buys/sells are always 0, so they show as unknown.
 */
function feedRow(r: any, source: string, signal: boolean): FeedRow {
  const created = num(signal ? (r.created_timestamp ?? r.open_timestamp) : (r.creation_timestamp ?? r.open_timestamp));
  return {
    address: String(r.address),
    symbol: typeof r.symbol === "string" ? r.symbol.slice(0, 40) : null,
    source,
    mcap: num(r.market_cap),
    liq: num(r.liquidity),
    buys: signal ? null : num(r.buys),
    sells: signal ? null : num(r.sells),
    change1h: signal ? null : num(r.price_change_percent1h),
    top10: num(r.top_10_holder_rate),
    bundler: num(r.bundler_rate ?? r.bundler_trader_amount_rate), // trending, then signal
    rug: num(r.rug_ratio),
    createdAt: created ? created * 1000 : null,
  };
}

async function fetchTokens(cfg: Config): Promise<string[]> {
  const c = gmgnClient();
  const [rank, signal] = await Promise.allSettled([
    c.getTrendingSwaps("sol", "1h", { order_by: "volume", limit: FEED_LIMIT, ...rankFilters(cfg) }),
    c.getTokenSignalV2("sol", SIGNAL_GROUPS.map((signal_type) => ({ signal_type, ...signalFilters(cfg) }))),
  ]);
  const rows = new Map<string, FeedRow>();
  const failed = (feed: string, e: unknown) => {
    log("warn", `${feed} feed failed: ${short(e)}`);
    status.gmgn = { errorAt: Date.now(), error: `${feed}: ${short(e)}` };
  };
  if (rank.status === "fulfilled") {
    // The rank route's data is itself an envelope: { code, data: { rank: [...] } }.
    const r: any = rank.value;
    for (const row of r?.rank ?? r?.data?.rank ?? [])
      if (row?.address && !row.is_wash_trading && inFilters(row, cfg)) rows.set(String(row.address), feedRow(row, "1h trending", false));
  } else failed("Trending", rank.reason);
  if (signal.status === "fulfilled") {
    const s: any = signal.value;
    tx(() => {
      for (const row of Array.isArray(s) ? s : (s?.list ?? [])) {
        // cur_data: the fresher top 10 / holders / liquidity; ath: the all-time-high market cap.
        // visiting_count is always 0 here, unlike on trending, so the viewers bound skips it.
        const data = { ...row?.data, ...row?.cur_data, ath: row?.ath, visiting_count: null, address: row?.token_address ?? row?.data?.address };
        if (!data.address || !inFilters(data, cfg)) continue;
        writeSignal(String(data.address), row);
        const seen = rows.get(String(data.address));
        if (seen) seen.source = seen.source === "signal" ? "signal" : "trending + signal";
        else rows.set(String(data.address), feedRow(data, "signal", true));
      }
    });
  } else failed("Signal", signal.reason);
  status.fetch = { at: Date.now(), rows: [...rows.values()] };
  return [...rows.keys()];
}

/** Waits whose recheck time has passed, whether or not a feed carried them this cycle. */
function waitsDue(now: number): string[] {
  return (
    db
      .prepare(
        `select d.token from decisions d where d.action = 'wait' and d.recheck_at <= ?
         and d.id = (select max(id) from decisions where token = d.token) order by d.recheck_at`,
      )
      .all(now) as { token: string }[]
  ).map((r) => r.token);
}

export type TokenStatus = { status: "due" | "waiting" | "holding" | "cooldown" | "skipped"; note: string; until: number | null };

/**
 * Where a token stands with the entry loop. Due: new, its wait is over, or bought and its
 * cooldown is over. Never due while held, blocked or skipped — skip is final.
 */
export function tokenStatus(token: string, cfg: Config, now: number): TokenStatus {
  const held = db.prepare("select opened_at from positions where token = ? and status = 'open'").get(token) as { opened_at: number } | undefined;
  if (held) return { status: "holding", note: "since", until: held.opened_at };
  const t = db.prepare("select blocked_at, blocked_reason from tokens where address = ?").get(token) as
    | { blocked_at: number | null; blocked_reason: string | null }
    | undefined;
  if (t?.blocked_at) return { status: "skipped", note: t.blocked_reason ?? "blocked", until: null };
  const d = db
    .prepare(
      `select d.action, d.recheck_at, d.thesis, r.started_at from decisions d join agent_runs r on r.id = d.run_id
       where d.token = ? order by d.id desc limit 1`,
    )
    .get(token) as { action: string; recheck_at: number | null; thesis: string | null; started_at: number } | undefined;
  if (!d) return { status: "due", note: "new", until: null };
  if (d.action === "skip") return { status: "skipped", note: d.thesis ?? "skipped", until: null };
  if (d.action === "wait") {
    const at = d.recheck_at ?? 0;
    return at > now ? { status: "waiting", note: "until", until: at } : { status: "due", note: "wait ended", until: at };
  }
  // A buy: the cooldown runs from the last close, or from the run if the buy never filled.
  const closed = (db.prepare("select max(closed_at) c from positions where token = ?").get(token) as { c: number | null }).c ?? 0;
  const at = Math.max(closed, d.started_at) + cfg.cooldownMinutes * 60_000;
  return at > now ? { status: "cooldown", note: "until", until: at } : { status: "due", note: "cooldown over", until: null };
}

export const isDue = (token: string, cfg: Config, now: number): boolean => tokenStatus(token, cfg, now).status === "due";

/** A risk-check refusal is a 'skip' row in the same run: final, like the agent's own skips. */
function veto(v: Verdict, reason: string, block = false): void {
  const run = db.prepare("select run_id from decisions where id = ?").get(v.decisionId) as { run_id: number };
  insert("decisions", { run_id: run.run_id, token: v.token, action: "skip", thesis: `risk check: ${reason}` });
  if (block) db.prepare("update tokens set blocked_at = ?, blocked_reason = ? where address = ?").run(Date.now(), reason, v.token);
  log("warn", `${symbolOf(v.token)} not bought — ${reason}.`);
}

const symbolOf = (token: string) =>
  (db.prepare("select symbol from tokens where address = ?").get(token) as { symbol: string | null } | undefined)?.symbol ?? token.slice(0, 6);

/** Security · slot · size · cash, then the entry snapshot and the buy. */
async function tryBuy(v: Verdict, cfg: Config): Promise<void> {
  const name = symbolOf(v.token);
  if (openPositions().length >= cfg.maxOpenPositions) return log("info", `${name} not bought — no free slot.`);
  const plan = cfg.exitMode === "agent" ? (v.plan ?? (cfg.agent.noPlan === "fixed" ? cfg.plan : null)) : cfg.plan;
  if (!plan) return veto(v, "the agent gave no exit plan that sells 100%");

  let risk: string;
  try {
    risk = await security(v.token);
  } catch (e) {
    // A read that failed is not a verdict on the token: no buy now, and it comes back after the cooldown.
    return log("warn", `${name} not bought — security read failed: ${short(e)}`);
  }
  if (risk) return veto(v, risk, true);

  const sizeUsd = cfg.sizeSol * (await solUsd());
  if (sizeUsd < MIN_BUY_USD) return log("warn", `${name} not bought — ${cfg.sizeSol} SOL is $${sizeUsd.toFixed(2)}, under the $${MIN_BUY_USD} floor.`);
  const cash = await cashUsd(cfg);
  if (cash < sizeUsd) return log("warn", `${name} not bought — $${cash.toFixed(2)} cash, the buy needs $${sizeUsd.toFixed(2)}.`);

  let entrySnapshotId: number;
  try {
    entrySnapshotId = await takeSnapshot(v.token, "entry"); // never skipped: every position records what it bought
  } catch (e) {
    return log("warn", `${name} not bought — entry snapshot failed: ${short(e)}`);
  }
  const err = await buy({ token: v.token, decisionId: v.decisionId, entrySnapshotId, plan, cfg });
  if (err) log("warn", `Buy ${name} failed: ${err}`);
}

let running = false;
/** One line per reason the loop is idle, said once until the reason changes. */
const idle = (why: string) => {
  if (why !== status.entry.note) log("info", why);
  status.entry.note = why;
};

export async function entryCycle(): Promise<void> {
  if (running) return; // a cycle held up by the rate limiter is skipped, not stacked
  running = true;
  status.entry.lastAt = Date.now();
  try {
    const cfg = loadConfig();
    if (!process.env.OPENROUTER_API_KEY) return idle("Buying off: OPENROUTER_API_KEY is not set.");
    if (cfg.mode === "live" && !jup.address()) return idle("Buying off: live mode needs SOLANA_PRIVATE_KEY.");
    const free = cfg.maxOpenPositions - openPositions().length;
    if (free <= 0) return idle(`Buying waits: ${cfg.maxOpenPositions} of ${cfg.maxOpenPositions} slots used.`);
    if (lossPaused(cfg)) return idle("Buying paused: max daily loss reached. Exits keep running.");
    status.entry.note = "";

    const now = Date.now();
    const candidates = [...new Set([...waitsDue(now), ...(await fetchTokens(cfg))])];
    const due = candidates.filter((t) => isDue(t, cfg, now)).slice(0, MAX_BRIEF);
    if (!due.length) return;

    const snaps: { token: string; snapshotId: number }[] = [];
    for (const token of due) {
      try {
        snaps.push({ token, snapshotId: await takeSnapshot(token, "decision") });
      } catch (e) {
        log("warn", `Snapshot ${token.slice(0, 6)}… failed: ${short(e)} — asked again next cycle.`);
      }
    }
    if (!snaps.length) return;

    const verdicts = await decide(snaps, cfg, free, cfg.sizeSol * (await solUsd()));
    if (!verdicts) return;
    const buys = verdicts.filter((v) => v.action === "buy").sort((a, b) => (b.conviction ?? 0) - (a.conviction ?? 0));
    for (const v of buys) await tryBuy(v, cfg);
  } catch (e) {
    log("error", `Entry cycle failed: ${short(e)}`);
  } finally {
    running = false;
  }
}
