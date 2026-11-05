import { inFilters, isPump, signalFilters, SIGNAL_TYPES, type Config } from "./config.ts";
import { db, insert } from "./db.ts";
import { gmgnClient } from "./gmgn/client.ts";
import * as jup from "./jupiter/client.ts";
import * as pools from "./jupiter/pools.ts";
import { log, short } from "./log.ts";
import { briefRow, signalName, signalRow, takeSnapshot } from "./snapshot.ts";
import { solUsd } from "./trade.ts";

/**
 * Shadow tracking: every token the agent decides on (buy, wait or skip) is followed for WINDOW_MS
 * off its pool's own reserves, so every candidate gets an outcome, bought or not. One sampled
 * source is tracked the same way and never bought: GMGN signal events of the types the Signals list
 * does not fetch ('signal'), one track per token and type, SAMPLE_MAX open at a time.
 *
 * One batched `getMultipleAccounts` read every STEP_MS prices every open track. This is its own
 * read, not the exit loop's watches: ending a track must never stop the price feed of a position
 * in the same token. Pump curves and PumpSwap pools in any quote token; a non-SOL quote's reserve
 * is turned into SOL at its price when the track starts. A curve that completes is followed to the
 * pool it migrates into. Read-only, no model; it keeps running while trading is stopped. A process
 * restart ends what was open as 'restart'. The scorecard and every replay read shadow_tracks.
 */

export const WINDOW_MS = 60 * 60_000;
export const STEP_MS = 2_000;
/** Open signal tracks, at most: what the read budget leaves after every decided token. */
export const SAMPLE_MAX = 20;
/** New signal tracks a minute, at most: each costs a /v1/token/info read off the entry loop's GMGN budget. */
export const SAMPLES_PER_MIN = 5;
/** The quote reserve under this share of its first reading: the pool drained, the track ends as a rug. */
const RUG_SHARE = 0.05;
/** A completed curve's PumpSwap pool is looked for this often, this many times (2 min). */
const MOVE_MS = 10_000;
const MOVE_TRIES = 12;
/** A horizon takes the last point at most this many steps before it (30s); older is no answer. */
const STALE_STEPS = 15;
const HORIZONS = [60, 300, 900, 1800, 3600] as const;
/** A signal event seen this long after it fired is no longer fresh: its track would start late. */
const FRESH_MS = 3 * 60_000;
/** A non-SOL quote's SOL price is asked of Jupiter again after this. */
const RATE_MS = 10 * 60_000;
/** After a failed read the tracker rests this long. */
const BACKOFF_MS = 10_000;

/** [% vs the first price, the quote reserve in SOL] at index × STEP_MS after the start; null where no read landed. */
export type Point = [number, number] | null;
/** rank and migration: sampled until 5 Nov 2026, kept for the tracks they left. */
export type Source = "decision" | "signal" | "rank" | "migration";

type Track = {
  id: number;
  source: Source;
  token: string;
  pool: string | null;
  startedAt: number;
  state: "new" | "live" | "moved";
  r: pools.Resolved | null;
  /** SOL per quote token: 1 for SOL, else fixed at the start. */
  rate: number | null;
  start: { price: number; liquidity: number } | null;
  points: Point[];
  tries: number;
  triedAt: number;
};

const tracks = new Map<number, Track>();
const rates = new Map<string, { sol: number; at: number }>();
const r2 = (x: number) => Math.round(x * 100) / 100;

function open(id: number, source: Source, token: string, pool: string | null, now: number): void {
  tracks.set(id, { id, source, token, pool, startedAt: now, state: "new", r: null, rate: null, start: null, points: [], tries: 0, triedAt: 0 });
}

/** Starts following a decided token. `features` is the brief row exactly as the agent got it; its pool_address is the pool. */
export function track(decisionId: number, token: string, features: Record<string, unknown>, now = Date.now()): void {
  const id = insert("shadow_tracks", { token, source: "decision", decision_id: decisionId, features: JSON.stringify(features), started_at: now });
  open(id, "decision", token, typeof features["pool_address"] === "string" ? features["pool_address"] : null, now);
}

/** A signal event to start a track for. */
export type Pick = { token: string; type: number; at: number; mc: number | null };

/**
 * The signal events to track, oldest first: of a type the Signals list does not fetch, fresh, a
 * pump.fun launch on a pump pool, inside the Signals filters, its token never decided, its token ×
 * type never tracked; as many as SAMPLES_PER_MIN and the room under SAMPLE_MAX allow. The rest are
 * offered again next minute while still fresh.
 */
export function pickSignals(events: any[], cfg: Config, now: number): Pick[] {
  const seen = new Set<string>();
  const fresh: Pick[] = [];
  for (const ev of events) {
    const row = signalRow(ev);
    const token = String(row.address ?? "");
    const type = Number(ev?.signal_type);
    const at = Number(ev?.trigger_at) * 1000;
    const key = `${token} ${type}`;
    if (!token || seen.has(key) || cfg.signalTypes.includes(type) || !(now - at <= FRESH_MS)) continue;
    if (!isPump(row) || !inFilters(row, cfg.signalFilters, now)) continue;
    seen.add(key);
    fresh.push({ token, type, at, mc: Number.isFinite(Number(ev?.trigger_mc)) ? Number(ev.trigger_mc) : null });
  }
  let n = 0;
  for (const t of tracks.values()) if (t.source === "signal") n++;
  const room = Math.min(SAMPLES_PER_MIN, SAMPLE_MAX - n);
  const decided = db.prepare("select 1 from decisions where token = ? limit 1");
  const tracked = db.prepare("select 1 from shadow_tracks where token = ? and source = 'signal' and json_extract(features, '$.signal_type') = ?");
  const out: Pick[] = [];
  for (const p of fresh.sort((a, b) => a.at - b.at)) {
    if (out.length >= room) break;
    if (!decided.get(p.token) && !tracked.get(p.token, signalName(p.type))) out.push(p);
  }
  return out;
}

let sampling = false;
let signalError = "";

/**
 * Once a minute while running: one token_signal request for every type the Signals list does not
 * fetch, under its filters, then a track per pick. `features` is the brief row of a fresh snapshot
 * (one per token, though two of its types start) plus the event: `signal_type`, `signal_mc_usd`
 * (the market cap it fired at) and `signal_age_s` (how long before the snapshot it fired).
 */
export async function sampleSignals(cfg: Config, now = Date.now()): Promise<void> {
  const types = SIGNAL_TYPES.filter((t) => !cfg.signalTypes.includes(t));
  if (sampling || !process.env.GMGN_API_KEY || !types.length) return;
  sampling = true;
  try {
    const res: any = await gmgnClient().getTokenSignalV2("sol", types.map((t) => ({ signal_type: [t], ...signalFilters(cfg) })));
    const rows = new Map<string, Record<string, unknown>>();
    for (const p of pickSignals(Array.isArray(res) ? res : (res?.list ?? []), cfg, now)) {
      let row = rows.get(p.token);
      if (!row) rows.set(p.token, (row = briefRow(await takeSnapshot(p.token, "sample"))));
      const at = Date.now();
      const features = { ...row, signal_type: signalName(p.type), signal_mc_usd: p.mc, signal_age_s: Math.round((at - p.at) / 1000) };
      const id = insert("shadow_tracks", { token: p.token, source: "signal", features: JSON.stringify(features), started_at: at });
      open(id, "signal", p.token, typeof row["pool_address"] === "string" ? row["pool_address"] : null, at);
    }
    signalError = "";
  } catch (e) {
    // The picks left over are offered again next minute, while still fresh.
    if (short(e) !== signalError) log("warn", `Signal tracks: ${short(e)} — tried again next minute.`);
    signalError = short(e);
  } finally {
    sampling = false;
  }
}

/** Tracks open right now, by source, for the dashboard. */
export function tracking(): { decision: number; signal: number } {
  const n = { decision: 0, signal: 0 };
  for (const t of tracks.values()) if (t.source === "decision" || t.source === "signal") n[t.source]++;
  return n;
}

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

/** New tracks find their pool's reserve accounts (all of them in two reads), and a non-SOL quote its SOL price. */
async function resolveNew(now: number): Promise<void> {
  const fresh = [...tracks.values()].filter((t) => t.state === "new");
  for (const t of fresh) if (!t.pool) end(t, "unreadable", now);
  const todo = fresh.filter((t) => !t.r && t.pool);
  if (todo.length) {
    const rs = await pools.resolvePools(todo.map((t) => ({ mint: t.token, pool: t.pool! })));
    todo.forEach((t, i) => (typeof rs[i] === "string" ? end(t, "unreadable", now) : (t.r = rs[i] as pools.Resolved)));
  }
  const stale = (q: string) => q !== jup.WSOL && now - (rates.get(q)?.at ?? 0) >= RATE_MS;
  const want = [...new Set(fresh.filter((t) => t.r && stale(t.r.quoteMint)).map((t) => t.r!.quoteMint))];
  if (want.length) {
    try {
      const px = await jup.prices([jup.WSOL, ...want]);
      const sol = px.get(jup.WSOL)?.usd;
      for (const q of want) {
        const usd = px.get(q)?.usd;
        if (sol && usd) rates.set(q, { sol: usd / sol, at: now });
        else rates.delete(q);
      }
    } catch {
      return; // asked again next step
    }
  }
  for (const t of fresh) {
    if (!t.r || !tracks.has(t.id)) continue;
    const rate = t.r.quoteMint === jup.WSOL ? 1 : rates.get(t.r.quoteMint)?.sol;
    if (rate) Object.assign(t, { rate, state: "live" });
    else if (want.length) end(t, "unreadable", now); // Jupiter has no price for the quote
  }
}

/** A completed curve: its PumpSwap pool is read once it exists, tried every MOVE_MS, MOVE_TRIES times. */
async function followMoved(now: number): Promise<void> {
  const due = [...tracks.values()].filter((t) => t.state === "moved" && now - t.triedAt >= MOVE_MS);
  if (!due.length) return;
  for (const t of due) Object.assign(t, { tries: t.tries + 1, triedAt: now });
  const moved = due.map((t) => ({ mint: t.token, pool: pools.migratedPool(t.token, t.r!.quoteMint) }));
  const rs = await pools.resolvePools(moved);
  due.forEach((t, i) => {
    const r = rs[i]!;
    if (typeof r !== "string" && r.quoteMint === t.r!.quoteMint) Object.assign(t, { pool: moved[i]!.pool, r, state: "live" });
    else if (t.tries >= MOVE_TRIES) end(t, "unreadable", now);
  });
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
      Object.assign(t, { state: "moved", tries: 0, triedAt: 0 });
      continue;
    }
    if (!x) continue;
    const liquidity = x.liquidity * t.rate!;
    if (!t.start) {
      t.start = { price: x.price, liquidity };
      usd ??= await solUsd().catch(() => 0);
      db.prepare("update shadow_tracks set start_price_usd = ? where id = ?").run(usd ? x.price * t.rate! * usd : null, t.id);
    }
    t.points[Math.round((now - t.startedAt) / STEP_MS)] = [r2((x.price / t.start.price - 1) * 100), r2(liquidity)];
    if (liquidity < t.start.liquidity * RUG_SHARE) end(t, "rug", now);
  }
}

let ticking = false;
let readDown = false;
let quietUntil = 0;

/**
 * One step: pools found, migrated curves followed, one read, finished windows written. Skipped
 * while the last runs. A failed read rests the tracker BACKOFF_MS: the RPC is the exit loop's too,
 * and a limit hit must not be made worse by research.
 */
export async function shadowTick(now = Date.now()): Promise<void> {
  if (ticking || !tracks.size) return;
  ticking = true;
  try {
    if (now >= quietUntil) {
      await resolveNew(now);
      await followMoved(now);
      await read(now);
      if (readDown) log("info", "Shadow reads are back.");
      readDown = false;
    }
  } catch (e) {
    // The steps missed are gaps in the paths; said once until the reads come back.
    if (!readDown) log("warn", `Shadow read failed: ${short(e)} — resting ${BACKOFF_MS / 1000}s, paths have gaps meanwhile.`);
    readDown = true;
    quietUntil = now + BACKOFF_MS;
  } finally {
    for (const t of [...tracks.values()]) if (now - t.startedAt >= WINDOW_MS) end(t, t.state === "live" ? "done" : "unreadable", now);
    ticking = false;
  }
}
