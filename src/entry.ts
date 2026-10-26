import { loadConfig, rankFilters, signalFilters, type Config } from "./config.ts";
import { db, insert } from "./db.ts";
import { decide, type Verdict } from "./decide.ts";
import { gmgnClient } from "./gmgn/client.ts";
import * as jup from "./jupiter/client.ts";
import { log, short } from "./log.ts";
import { takeSnapshot } from "./snapshot.ts";
import { buy, buyingPaused, cashUsd, MIN_BUY_USD, openPositions, security, solUsd } from "./trade.ts";

/**
 * The entry loop, once per CYCLE_MS: fetch → keep what is due → snapshot it → one agent run →
 * save verdicts → risk check and buy, best conviction first. Skip is final, a wait returns when
 * its time is up, a token bought and sold returns after the cooldown.
 */

export const CYCLE_MS = 60_000;
/** Due tokens per agent run, at most; the rest stay due for the next cycle. */
const MAX_BRIEF = 10;
const FEED_LIMIT = 40;
/** smart-money buy, price spike, new all-time high. */
const SIGNAL_TYPES = [12, 6, 7];

/** GMGN 1h trending + signal, in that order, deduped. A feed that fails is logged and left out. */
async function fetchTokens(cfg: Config): Promise<string[]> {
  const c = gmgnClient();
  const [rank, signal] = await Promise.allSettled([
    c.getTrendingSwaps("sol", "1h", { order_by: "volume", limit: FEED_LIMIT, ...rankFilters(cfg) }),
    c.getTokenSignalV2("sol", [{ signal_type: SIGNAL_TYPES, ...signalFilters(cfg) }]),
  ]);
  const out: string[] = [];
  if (rank.status === "fulfilled") {
    // The rank route's data is itself an envelope: { code, data: { rank: [...] } }.
    const r: any = rank.value;
    for (const row of r?.rank ?? r?.data?.rank ?? []) if (row?.address && !row.is_wash_trading) out.push(String(row.address));
  } else log("warn", `Trending feed failed: ${short(rank.reason)}`);
  if (signal.status === "fulfilled") {
    const s: any = signal.value;
    for (const row of Array.isArray(s) ? s : (s?.list ?? [])) {
      const a = row?.token_address ?? row?.data?.address;
      if (a) out.push(String(a));
    }
  } else log("warn", `Signal feed failed: ${short(signal.reason)}`);
  return [...new Set(out)];
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

/** New, or its wait is over, or bought and its cooldown is over. Never blocked, held or skipped. */
export function isDue(token: string, cfg: Config, now: number): boolean {
  const t = db.prepare("select blocked_at from tokens where address = ?").get(token) as { blocked_at: number | null } | undefined;
  if (t?.blocked_at) return false;
  if (db.prepare("select 1 from positions where token = ? and status = 'open'").get(token)) return false;
  const d = db
    .prepare(
      `select d.action, d.recheck_at, r.started_at from decisions d join agent_runs r on r.id = d.run_id
       where d.token = ? order by d.id desc limit 1`,
    )
    .get(token) as { action: string; recheck_at: number | null; started_at: number } | undefined;
  if (!d) return true;
  if (d.action === "skip") return false;
  if (d.action === "wait") return (d.recheck_at ?? 0) <= now;
  // A buy: the cooldown runs from the last close, or from the run if the buy never filled.
  const closed = (db.prepare("select max(closed_at) c from positions where token = ?").get(token) as { c: number | null }).c ?? 0;
  return Math.max(closed, d.started_at) + cfg.cooldownMinutes * 60_000 <= now;
}

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
let said = "";
/** One line per reason the loop is idle, said once until the reason changes. */
const idle = (why: string) => {
  if (why !== said) log("info", why);
  said = why;
};

export async function entryCycle(): Promise<void> {
  if (running) return; // a cycle held up by the rate limiter is skipped, not stacked
  running = true;
  try {
    const cfg = loadConfig();
    if (!process.env.OPENROUTER_API_KEY) return idle("Buying off: OPENROUTER_API_KEY is not set.");
    if (cfg.mode === "live" && !jup.address()) return idle("Buying off: live mode needs SOLANA_PRIVATE_KEY.");
    const free = cfg.maxOpenPositions - openPositions().length;
    if (free <= 0) return idle(`Buying waits: ${cfg.maxOpenPositions} of ${cfg.maxOpenPositions} slots used.`);
    if (buyingPaused(cfg)) return idle(`Buying paused: today's loss passed ${cfg.maxDailyLossPct}% of the day's start. Exits keep running.`);
    said = "";

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
