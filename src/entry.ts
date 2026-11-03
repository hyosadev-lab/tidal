import { inFilters, loadConfig, rankFilters, trenchesFilters, type Config } from "./config.ts";
import { getRun, lossPaused, status, type FeedRow } from "./control.ts";
import { db, insert, tx } from "./db.ts";
import { decide, type Due, type Verdict } from "./decide.ts";
import { gmgnClient } from "./gmgn/client.ts";
import * as jup from "./jupiter/client.ts";
import { log, short } from "./log.ts";
import { sampleRank } from "./shadow.ts";
import { takeSnapshot } from "./snapshot.ts";
import { buy, cashUsd, lossDay, MIN_BUY_USD, openPositions, positionClosed, security, solUsd } from "./trade.ts";

/**
 * The entry loop, cycle after cycle with no pause between: fetch → keep what is due → snapshot it
 * → one agent run → save verdicts → risk check and buy, best conviction first. Skip is final, a
 * wait returns when its time is up, a token bought and sold returns after the cooldown. With no
 * free slot (or buying paused) it waits, with no fetch and no agent run, until something wakes it.
 */

/** Due tokens per agent run, at most; the rest stay due for the next cycle. */
const MAX_BRIEF = 10;
const FEED_LIMIT = 40;
/**
 * pump.fun's launchpads in GMGN's names: their tokens start on a pump curve and migrate to PumpSwap,
 * the pools the exit loop and shadow tracks read on-chain. Only the first two seen so far (3 Nov 2026).
 */
const PUMP = ["Pump.fun", "pump_mayhem", "pump_agent", "pump_mayhem_agent"];
/** The two lists, as the brief's `feed` names them. */
export const LISTS = { trending: "1h trending", graduated: "graduated" } as const;
export type List = keyof typeof LISTS;

const num = (v: unknown): number | null => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/** A pump.fun launch on a pump curve or a PumpSwap pool: the exchange check keeps any other pool out. */
export const isPump = (r: any): boolean =>
  (PUMP.includes(r?.launchpad_platform) || r?.launchpad === "pump") && ["pump", "pump_amm"].includes(r?.exchange);

/** One list's row in its own numbers: trenches rows carry 24h buys and sells and no 1h change. */
function feedRow(r: any, list: List): FeedRow {
  const g = list === "graduated";
  const created = num(r.creation_timestamp ?? r.created_timestamp ?? r.open_timestamp);
  const migrated = g ? num(r.complete_timestamp) : null;
  return {
    address: String(r.address),
    symbol: typeof r.symbol === "string" ? r.symbol.slice(0, 40) : null,
    list,
    mcap: num(r.market_cap),
    liq: num(r.liquidity),
    buys: num(g ? r.buys_24h : r.buys),
    sells: num(g ? r.sells_24h : r.sells),
    change1h: g ? null : num(r.price_change_percent1h),
    top10: num(r.top_10_holder_rate),
    bundler: num(r.bundler_rate ?? r.bundler_trader_amount_rate), // trending, then trenches
    rug: num(r.rug_ratio),
    createdAt: created ? created * 1000 : null,
    migratedAt: migrated ? migrated * 1000 : null,
  };
}

/** a[0], b[0], a[1], b[1], …: neither list starves the other of brief places. */
export const interleave = <T>(a: T[], b: T[]): T[] =>
  Array.from({ length: Math.max(a.length, b.length) }, (_, i) => [a[i], b[i]]).flat().filter((x): x is T => x !== undefined);

/** `wash`: tokens GMGN flagged as wash-traded on either list — kept, and told to the agent. */
type Fetched = Record<List, string[]> & { rank: Record<string, any>[]; wash: Set<string> };

/** The brief's `feed`: the list or lists that carried the token this cycle; null for a wait off both. */
export const feedOf = (token: string, f: Record<List, string[]>): string | null =>
  (Object.keys(LISTS) as List[]).filter((k) => f[k].includes(token)).map((k) => LISTS[k]).join(" + ") || null;

/**
 * GMGN 1h trending and the graduated list (trenches 'completed': fresh PumpSwap migrations),
 * Pump.fun launches only, each under its own filters. A token on both has a row in each. The
 * trending rows as GMGN sent them go to rank shadow tracks.
 */
async function fetchTokens(cfg: Config): Promise<Fetched> {
  const c = gmgnClient();
  const [rank, done] = await Promise.allSettled([
    c.getTrendingSwaps("sol", "1h", { order_by: "volume", limit: FEED_LIMIT, platforms: PUMP, ...rankFilters(cfg) }),
    c.getTrenches("sol", ["completed"], PUMP, FEED_LIMIT, trenchesFilters(cfg)),
  ]);
  const rows: FeedRow[] = [];
  const out: Fetched = { trending: [], graduated: [], rank: [], wash: new Set() };
  const failed = (feed: string, e: unknown) => {
    const error = `${feed}: ${short(e)}`;
    if (error !== status.gmgn.error) log("warn", `${feed} feed failed: ${short(e)}`); // once, not every cycle
    status.gmgn = { errorAt: Date.now(), error };
  };
  // GMGN's platform params narrow both lists; the row check holds whatever slips through.
  const keep = (list: List, row: any, filters: Record<string, number>) => {
    if (!row?.address || !isPump(row) || !inFilters(row, filters)) return false;
    if (row.is_wash_trading) out.wash.add(String(row.address));
    rows.push(feedRow(row, list));
    out[list].push(String(row.address));
    return true;
  };
  if (rank.status === "fulfilled") {
    // The rank route's data is itself an envelope: { code, data: { rank: [...] } }.
    const r: any = rank.value;
    for (const row of r?.rank ?? r?.data?.rank ?? []) if (keep("trending", row, cfg.filters)) out.rank.push(row);
  } else failed("Trending", rank.reason);
  if (done.status === "fulfilled") {
    const d: any = done.value;
    for (const row of (d?.data ?? d)?.completed ?? []) if (row?.exchange === "pump_amm") keep("graduated", row, cfg.graduatedFilters);
  } else failed("Graduated", done.reason);
  status.fetch = { at: Date.now(), rows };
  return out;
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

/** One line per reason the loop is idle, said once until the reason changes. */
const idle = (why: string): false => {
  if (why !== status.entry.note) log("info", why);
  status.entry.note = why;
  return false;
};

let wakeUp: (() => void) | null = null;

/** Ends an idle wait: a close, Start, Resume or saved settings may let the loop buy again. */
export function wake(): void {
  const w = wakeUp;
  wakeUp = null;
  w?.();
}
positionClosed.addEventListener("close", wake);

let looping = false;

/**
 * Runs cycles back to back while the run is started. A cycle that cannot buy waits for `wake`,
 * or for 00:00 UTC, when a daily-loss pause lifts on its own. Called while running, it wakes it.
 */
export async function entryLoop(): Promise<void> {
  if (looping) return wake();
  looping = true;
  try {
    while (getRun().state === "running")
      if (!(await entryCycle()))
        await new Promise<void>((resolve) => {
          const t = setTimeout(wake, lossDay(Date.now()) + 86_400_000 - Date.now());
          wakeUp = () => (clearTimeout(t), resolve());
        });
  } finally {
    looping = false;
  }
}

/** One cycle. False when it could not buy and fetched nothing: the loop then waits for a wake. */
async function entryCycle(): Promise<boolean> {
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
    const feed = await fetchTokens(cfg);
    const isDueNow = (t: string) => isDue(t, cfg, now);
    // Waits first, then the two lists turn about; a token on both takes its first place.
    const due = [...new Set([...waitsDue(now).filter(isDueNow), ...interleave(feed.trending.filter(isDueNow), feed.graduated.filter(isDueNow))])].slice(0, MAX_BRIEF);
    try {
      sampleRank(feed.rank, new Set(due));
    } catch (e) {
      log("warn", `Rank shadow tracks not started: ${short(e)}`); // research only: never stops a cycle
    }
    if (!due.length) return true;

    const snaps: Due[] = [];
    for (const token of due) {
      try {
        snaps.push({ token, snapshotId: await takeSnapshot(token, "decision"), feed: feedOf(token, feed), wash: feed.wash.has(token) });
      } catch (e) {
        log("warn", `Snapshot ${token.slice(0, 6)}… failed: ${short(e)} — asked again next cycle.`);
      }
    }
    if (!snaps.length) return true;

    const verdicts = await decide(snaps, cfg, free, cfg.sizeSol * (await solUsd()));
    if (!verdicts) return true;
    const buys = verdicts.filter((v) => v.action === "buy").sort((a, b) => (b.conviction ?? 0) - (a.conviction ?? 0));
    for (const v of buys) await tryBuy(v, cfg);
  } catch (e) {
    log("error", `Entry cycle failed: ${short(e)}`);
  }
  return true;
}
