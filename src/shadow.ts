import { db, insert } from "./db.ts";
import { gmgnClient } from "./gmgn/client.ts";
import { WSOL } from "./jupiter/client.ts";
import * as pools from "./jupiter/pools.ts";
import { log, short } from "./log.ts";
import { solUsd } from "./trade.ts";

/**
 * Shadow tracking: every token the agent decides on (buy, wait or skip) is followed for WINDOW_MS
 * off its pool's own reserves, so every candidate gets an outcome, bought or not. One batched
 * `getMultipleAccounts` read every STEP_MS prices all of them. This is its own read, not the exit
 * loop's watches: ending a track must never stop the price feed of a position in the same token.
 * A curve that completes is followed to the pool GMGN names next. Read-only, no model; it keeps
 * running while trading is stopped. A process restart ends what was open as 'restart'.
 * The scorecard and every replay read shadow_tracks, never GMGN klines.
 */

export const WINDOW_MS = 60 * 60_000;
export const STEP_MS = 2_000;
/** The quote reserve under this share of its first reading: the pool drained, the track ends as a rug. */
const RUG_SHARE = 0.05;
/** A completed curve's new pool is asked of GMGN this often, at most MOVE_ASKS times. */
const MOVE_ASK_MS = 30_000;
const MOVE_ASKS = 5;
/** A horizon takes the last point at most this many steps before it (30s); older is no answer. */
const STALE_STEPS = 15;
const HORIZONS = [60, 300, 900, 1800, 3600] as const;

/** [% vs the first price, the quote reserve in SOL] at index × STEP_MS after the start; null where no read landed. */
export type Point = [number, number] | null;

type Track = {
  id: number;
  token: string;
  pool: string | null;
  startedAt: number;
  state: "new" | "live" | "moved";
  r: pools.Resolved | null;
  start: { price: number; liquidity: number } | null;
  points: Point[];
  asks: number;
  askedAt: number;
};

const tracks = new Map<number, Track>();
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Starts following a decided token. `features` is the brief row exactly as the agent got it; its pool_address is the pool. */
export function track(decisionId: number, token: string, features: Record<string, unknown>, now = Date.now()): void {
  const id = insert("shadow_tracks", { token, source: "decision", decision_id: decisionId, features: JSON.stringify(features), started_at: now });
  const pool = typeof features["pool_address"] === "string" ? features["pool_address"] : null;
  tracks.set(id, { id, token, pool, startedAt: now, state: "new", r: null, start: null, points: [], asks: 0, askedAt: 0 });
}

/** Tracks open right now, for the dashboard. */
export const tracking = (): number => tracks.size;

/** At boot: whatever was still open when the process stopped ends as 'restart', left out of every count. */
export function endRestarted(now = Date.now()): number {
  return Number(db.prepare("update shadow_tracks set ended_at = ?, end_reason = 'restart' where ended_at is null").run(now).changes);
}

/**
 * The returns at 1·5·15·30·60 min and the extremes, off a track's points. A horizon with no point
 * in the 30s before it is null. After a rug every horizon is −100: whoever still held cannot sell. Pure.
 */
export function outcome(points: Point[], rug: boolean) {
  const last = points.length - 1;
  const at = (sec: number): number | null => {
    const want = (sec * 1000) / STEP_MS;
    if (rug && want >= last) return -100;
    for (let i = Math.min(want, last); i >= 0 && i > want - STALE_STEPS; i--) if (points[i]) return points[i]![0];
    return null;
  };
  let hi = -1;
  let lo = -1;
  for (let i = 0; i <= last; i++) {
    const p = points[i];
    if (!p) continue;
    if (hi < 0 || p[0] > points[hi]![0]) hi = i;
    if (lo < 0 || p[0] < points[lo]![0]) lo = i;
  }
  const sec = (i: number) => (i < 0 ? null : (i * STEP_MS) / 1000);
  const [ret_1m, ret_5m, ret_15m, ret_30m, ret_60m] = HORIZONS.map(at);
  return {
    ret_1m: ret_1m ?? null,
    ret_5m: ret_5m ?? null,
    ret_15m: ret_15m ?? null,
    ret_30m: ret_30m ?? null,
    ret_60m: ret_60m ?? null,
    max_pct: hi < 0 ? null : points[hi]![0],
    max_at: sec(hi),
    min_pct: rug && last >= 0 ? -100 : lo < 0 ? null : points[lo]![0],
    min_at: sec(rug ? last : lo),
  };
}

function end(t: Track, reason: "done" | "rug" | "unreadable", now: number): void {
  tracks.delete(t.id);
  const o = outcome(t.points, reason === "rug");
  db.prepare(
    `update shadow_tracks set ended_at = ?, end_reason = ?, path = ?, ret_1m = ?, ret_5m = ?, ret_15m = ?, ret_30m = ?,
       ret_60m = ?, max_pct = ?, max_at = ?, min_pct = ?, min_at = ? where id = ?`,
  ).run(now, reason, t.points.length ? JSON.stringify(t.points) : null, o.ret_1m, o.ret_5m, o.ret_15m, o.ret_30m, o.ret_60m,
    o.max_pct, o.max_at, o.min_pct, o.min_at, t.id);
}

/** New tracks find their pool's reserve accounts. Only SOL-quoted pump curves and PumpSwap pools are read. */
async function resolveNew(now: number): Promise<void> {
  for (const t of [...tracks.values()].filter((t) => t.state === "new")) {
    if (!t.pool) {
      end(t, "unreadable", now);
      continue;
    }
    let r: pools.Resolved | string;
    try {
      r = await pools.resolvePool(t.token, t.pool);
    } catch {
      continue; // the network: tried again next step
    }
    // ponytail: SOL-quoted pools only (every pump curve and pump migration); others need a quote price
    if (typeof r === "string" || r.quoteMint !== WSOL) end(t, "unreadable", now);
    else Object.assign(t, { r, state: "live" });
  }
}

/** A completed curve: GMGN names the pool it moved to, asked every MOVE_ASK_MS, MOVE_ASKS times at most. */
async function askMoved(now: number): Promise<void> {
  for (const t of [...tracks.values()].filter((t) => t.state === "moved" && now - t.askedAt >= MOVE_ASK_MS)) {
    if (t.asks >= MOVE_ASKS) {
      end(t, "unreadable", now);
      continue;
    }
    t.asks++;
    t.askedAt = now;
    try {
      const pool = ((await gmgnClient().getTokenInfo("sol", t.token)) as any)?.pool?.pool_address;
      if (typeof pool === "string" && pool && pool !== t.pool) Object.assign(t, { pool, state: "new" });
    } catch {
      /* asked again after MOVE_ASK_MS */
    }
  }
}

/** One read of every live track's accounts, a point each. */
async function read(now: number): Promise<void> {
  const live = [...tracks.values()].filter((t) => t.state === "live");
  const keys = [...new Set(live.flatMap((t) => t.r!.accounts))];
  if (!keys.length) return;
  const got = new Map<string, Buffer>();
  for (let i = 0; i < keys.length; i += 100) {
    const r = await pools.accounts(keys.slice(i, i + 100));
    r.list.forEach((a, j) => a && got.set(keys[i + j]!, a.data));
  }
  let usd: number | null = null;
  for (const t of live) {
    const data = t.r!.accounts.map((a) => got.get(a));
    if (data.some((d) => !d)) continue; // a gap
    const x = pools.poolReading(t.r!, data as Buffer[]);
    if (x === "complete") {
      Object.assign(t, { state: "moved", askedAt: 0 });
      continue;
    }
    if (!x) continue;
    if (!t.start) {
      t.start = x;
      usd ??= await solUsd().catch(() => 0);
      db.prepare("update shadow_tracks set start_price_usd = ? where id = ?").run(usd ? x.price * usd : null, t.id);
    }
    t.points[Math.round((now - t.startedAt) / STEP_MS)] = [r2((x.price / t.start.price - 1) * 100), r2(x.liquidity)];
    if (x.liquidity < t.start.liquidity * RUG_SHARE) end(t, "rug", now);
  }
}

let ticking = false;
let readDown = false;

/** One step: pools found, moved curves followed, one read, finished windows written. Skipped while the last runs. */
export async function shadowTick(now = Date.now()): Promise<void> {
  if (ticking || !tracks.size) return;
  ticking = true;
  try {
    await resolveNew(now);
    await askMoved(now);
    await read(now);
    if (readDown) log("info", "Shadow reads are back.");
    readDown = false;
  } catch (e) {
    // The steps missed are gaps in the paths; said once until the reads come back.
    if (!readDown) log("warn", `Shadow read failed: ${short(e)} — paths have gaps until it is back.`);
    readDown = true;
  } finally {
    for (const t of [...tracks.values()]) if (now - t.startedAt >= WINDOW_MS) end(t, t.state === "live" ? "done" : "unreadable", now);
    ticking = false;
  }
}
