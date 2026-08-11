/**
 * Forward-outcome log: every candidate the sweep saw, and what its price did afterwards.
 *
 * `score()` in plan.ts is hand-weighted. Some of its break points are GMGN's published
 * pass/skip bands (liquidity $10k, rug_ratio 0.3); the rest — the relative weights above
 * all — are judgement, and nothing in this repo says whether they rank anything. This file
 * is the cheap half of finding out: the scan already computes every feature and the price
 * at that moment, so recording them costs no extra API call and no latency. `calibrate.ts`
 * re-prices the rows later and reports whether a higher score actually paid.
 *
 * The whole sweep is recorded, gate failures included — an unbiased sample is the point.
 * Measuring only what was bought measures the analyst, not the score.
 *
 * Two tables in `data/tta.db`:
 *   soundings — one row per candidate per cycle, written by the scan loop
 *   outcomes  — one row per resolved sounding, written by a calibration run
 *
 * ponytail: no retention policy. ~40 rows a cycle stays small for years in SQLite; if it ever
 * matters, `delete from soundings where ts < …` older than the longest horizon you report on.
 */
import { db, insertOutcome, insertSounding, rowsJson } from "./db.ts";
import type { Candidate, Chain } from "./types.ts";

/** One candidate as `score()` saw it, at the moment it was scored. */
export type Sounding = { ts: number; cycle: number; chain: Chain; c: Candidate };

/**
 * What that row was worth later. `priceNow: null` means the price could not be read —
 * kept distinct from a real zero, because "the token is gone" and "the call failed" look
 * identical from here and only one of them is a -100% return.
 */
export type Outcome = { key: string; ageHours: number; priceThen: number; priceNow: number | null };

export const soundingKey = (s: Sounding): string => `${s.cycle}:${s.c.address}`;

/** Fire-and-forget: telemetry must never be able to break a scan. */
export function recordSoundings(cycle: number, chain: Chain, candidates: Candidate[]): void {
  const ts = Date.now();
  try {
    for (const c of candidates) {
      const s: Sounding = { ts, cycle, chain, c };
      insertSounding(soundingKey(s), s);
    }
  } catch {
    /* a full disk is not a reason to stop trading */
  }
}

export function recordOutcome(o: Outcome): void {
  insertOutcome(o.key, o);
}

export const soundingCount = (): number => (db.prepare("select count(*) n from soundings").get() as { n: number }).n;

/** Soundings inside the horizon that no run has priced yet, oldest first — those expire soonest. */
export function unresolved(minTs: number, maxTs: number, limit: number): Sounding[] {
  return rowsJson<Sounding>(
    `select s.json from soundings s left join outcomes o on o.key = s.key
     where o.key is null and s.ts between ? and ? order by s.ts limit ?`,
    minTs,
    maxTs,
    limit,
  );
}

/** Every resolved row, sounding and outcome joined — the calibration dataset. */
export function resolvedPairs(): { s: Sounding; o: Outcome }[] {
  const rows = db.prepare("select s.json sj, o.json oj from outcomes o join soundings s on s.key = o.key").all() as {
    sj: string;
    oj: string;
  }[];
  return rows.map((r) => ({ s: JSON.parse(r.sj) as Sounding, o: JSON.parse(r.oj) as Outcome }));
}
