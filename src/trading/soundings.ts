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
 * Two append-only JSONL files in gitignored `data/`:
 *   soundings.jsonl — one line per candidate per cycle, written by the scan loop
 *   outcomes.jsonl  — one line per resolved sounding, written by a calibration run
 *
 * ponytail: append-only, no rotation. ~40 rows a cycle is a few MB a month; if that ever
 * matters, drop lines older than the longest horizon you report on.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import type { Candidate, Chain } from "./types.ts";

export const SOUNDINGS_PATH = join(DATA_DIR, "soundings.jsonl");
export const OUTCOMES_PATH = join(DATA_DIR, "outcomes.jsonl");

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
  if (!candidates.length) return;
  const ts = Date.now();
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(
      SOUNDINGS_PATH,
      candidates.map((c) => JSON.stringify({ ts, cycle, chain, c } satisfies Sounding)).join("\n") + "\n",
    );
  } catch {
    /* a full disk is not a reason to stop trading */
  }
}

export function recordOutcome(o: Outcome): void {
  mkdirSync(DATA_DIR, { recursive: true });
  appendFileSync(OUTCOMES_PATH, JSON.stringify(o) + "\n");
}

/** Tolerant reader: a half-written last line (killed mid-append) is skipped, not fatal. */
export function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      /* skip */
    }
  }
  return out;
}
