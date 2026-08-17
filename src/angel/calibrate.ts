/**
 * Does the score rank anything? — the evidence behind `score()` in plan.ts.
 *
 * Reads `data/soundings.jsonl` (written by every scan), re-prices each row once it is old
 * enough to have an answer, and reports three things:
 *
 *   1. score band → what those tokens actually did. If the bands are flat, the score is noise.
 *   2. the production cut: rows the sweep ranked top-18 in their cycle vs. everything else,
 *      since that slice is exactly what reaches the analyst.
 *   3. rank correlation per feature. A term whose ρ is ~0 is not earning its weight; a term
 *      whose ρ has the opposite sign to its weight is actively costing money.
 *
 * This does not tune anything. It hands you numbers; the weights stay hand-edited in plan.ts,
 * because a curve fitted to a few hundred memecoins is a worse prior than a stated judgement.
 *
 *   npm run calibrate -- --min-age=0.25 --max-age=1 --limit=300
 *
 * `--limit=0` reports on what is already resolved without spending a single API call.
 */
import { num } from "./core/config.ts";
import * as gmgn from "./exec/market.ts";
import { recordOutcome, resolvedPairs, soundingCount, soundingKey, unresolved } from "./state/soundings.ts";
import type { Sounding } from "./state/soundings.ts";
import type { Candidate } from "./core/types.ts";

/** The terms `score()` actually reads. Keep in step with it, or a new term goes unmeasured. */
const FEATURES = [
  "smartDegenCount",
  "renownedCount",
  "change1hPct",
  "change5mPct",
  "liquidityUsd",
  "volume1hUsd",
  "swaps1h",
  "holderCount",
  "rugRatio",
  "top10HolderRate",
  "ageMinutes",
  "marketCapUsd",
] as const satisfies readonly (keyof Candidate)[];

// ── statistics (pure; tested in plan.test.ts) ─────────────────────────

const mean = (v: number[]): number => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);

export function median(v: number[]): number {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Ranks with ties averaged, so a constant column ranks flat instead of by input order. */
function ranks(v: number[]): number[] {
  const order = v.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(v.length);
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]![0] === order[i]![0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[order[k]![1]!] = avg;
    i = j + 1;
  }
  return out;
}

/**
 * Spearman ρ. Rank correlation rather than Pearson because memecoin returns are wildly
 * heavy-tailed — one 40x would otherwise decide the answer on its own.
 * Returns 0 when there is nothing to correlate (too few rows, or a constant column).
 */
export function spearman(xs: number[], ys: number[]): number {
  if (xs.length !== ys.length || xs.length < 3) return 0;
  const rx = ranks(xs);
  const ry = ranks(ys);
  const mx = mean(rx);
  const my = mean(ry);
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < rx.length; i++) {
    const a = rx[i]! - mx;
    const b = ry[i]! - my;
    cov += a * b;
    vx += a * a;
    vy += b * b;
  }
  return vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : 0;
}

export type Band = { label: string; n: number; median: number; mean: number; winRate: number; bigWinRate: number };

/** Buckets rows by score into `[0,20) [20,40) …`, and describes what each bucket returned. */
export function bands(rows: { score: number; ret: number }[], edges = [20, 40, 60, 80]): Band[] {
  const bounds = [0, ...edges, Infinity];
  const out: Band[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const lo = bounds[i]!;
    const hi = bounds[i + 1]!;
    const hit = rows.filter((r) => r.score >= lo && r.score < hi);
    const rets = hit.map((r) => r.ret);
    out.push({
      label: hi === Infinity ? `${lo}+` : `${lo}–${hi - 1}`,
      n: hit.length,
      median: median(rets),
      mean: mean(rets),
      winRate: rets.length ? rets.filter((r) => r > 0).length / rets.length : 0,
      bigWinRate: rets.length ? rets.filter((r) => r > 0.2).length / rets.length : 0,
    });
  }
  return out;
}

// ── resolving (the only part that spends API calls) ───────────────────

/**
 * Prices every sounding old enough to have an answer, once. Results are appended to
 * outcomes.jsonl, so a later run never re-fetches a row — the dataset accumulates across
 * runs instead of being rebuilt.
 *
 * Rows younger than `minAgeH` are left alone. An outcome is written once and never revisited,
 * so the horizon has to match how long a position is actually held — measure a two-day return
 * and you are grading the score on a question the engine never asks. `timeStopMinutes` is what
 * sets that length; the default here is the short end of it, so raise `--min-age` (and
 * `--max-age` with it, or the oldest pending rows eat the budget first) when you hold longer.
 */
async function resolve(minAgeH: number, maxAgeH: number, limit: number): Promise<number> {
  const now = Date.now();
  // Oldest first inside the horizon — those are closest to falling out of it entirely.
  const pending = unresolved(now - maxAgeH * 3_600_000, now - minAgeH * 3_600_000, limit).filter(
    (s) => s.c.priceUsd > 0,
  );

  if (!pending.length) return 0;
  process.stdout.write(`resolving ${pending.length} soundings`);
  for (const s of pending) {
    let priceNow: number | null = null;
    try {
      const info = await gmgn.tokenInfo(s.chain, s.c.address);
      const p = num(info?.price?.price);
      priceNow = p > 0 ? p : null;
    } catch {
      priceNow = null; // delisted, or the call failed — indistinguishable from here
    }
    recordOutcome({
      key: soundingKey(s),
      ageHours: Number(((now - s.ts) / 3_600_000).toFixed(2)),
      priceThen: s.c.priceUsd,
      priceNow,
    });
    process.stdout.write(".");
  }
  process.stdout.write("\n");
  return pending.length;
}

// ── report ────────────────────────────────────────────────────────────

const pct = (x: number): string => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
const rho = (x: number): string => `${x >= 0 ? "+" : ""}${x.toFixed(3)}`;

function report(minAgeH: number, maxAgeH: number): void {
  const rows: { s: Sounding; ret: number; age: number }[] = [];
  let unreadable = 0;
  let offHorizon = 0;
  for (const { s, o } of resolvedPairs()) {
    // An outcome is permanent and answers only for the horizon it was priced at, so the table
    // accumulates every horizon anyone has ever run. Averaging a 15-minute move together with a
    // two-day one and calling the result a ranking is worse than having no number at all.
    if (o.ageHours < minAgeH || o.ageHours > maxAgeH) {
      offHorizon++;
      continue;
    }
    if (o.priceThen <= 0) continue;
    if (o.priceNow === null) {
      unreadable++;
      continue;
    }
    rows.push({ s, ret: (o.priceNow - o.priceThen) / o.priceThen, age: o.ageHours });
  }

  console.log(
    `\nsoundings ${soundingCount()} · resolved ${rows.length} · unreadable ${unreadable}` +
      (offHorizon ? ` · ${offHorizon} excluded, priced at another horizon` : ""),
  );
  if (unreadable) {
    const share = unreadable / (rows.length + unreadable);
    console.log(
      `  ${pct(share).replace("+", "")} of resolved rows had no readable price. A delisted token and a` +
        ` failed call look the same from here, so they are excluded — if most were dead tokens,` +
        ` every number below is optimistic.`,
    );
  }
  if (rows.length < 30) {
    console.log(`\nToo few rows at this horizon to read anything into.`);
    console.log(
      `(a row is resolvable from ${minAgeH}h after its scan and expires at ${maxAgeH}h, so run this while` +
        ` the agent is running — a row nobody priced inside that window cannot be priced later.)\n`,
    );
    return;
  }

  const ages = rows.map((r) => r.age);
  console.log(`horizon ${minAgeH}–${maxAgeH}h · median hold ${median(ages).toFixed(1)}h\n`);

  console.log(`score      n     median      mean     win%    >+20%`);
  for (const b of bands(rows.map((r) => ({ score: r.s.c.score, ret: r.ret })))) {
    if (!b.n) continue;
    console.log(
      `${b.label.padEnd(8)}${String(b.n).padStart(4)}` +
        `${pct(b.median).padStart(11)}${pct(b.mean).padStart(10)}` +
        `${(b.winRate * 100).toFixed(0).padStart(8)}%${(b.bigWinRate * 100).toFixed(0).padStart(8)}%`,
    );
  }

  // The cut the engine actually makes: top 18 by score within each cycle reaches the analyst.
  const byCycle = new Map<number, typeof rows>();
  for (const r of rows) byCycle.set(r.s.cycle, [...(byCycle.get(r.s.cycle) ?? []), r]);
  const shown: number[] = [];
  const rest: number[] = [];
  for (const group of byCycle.values()) {
    const ranked = [...group].sort((a, b) => b.s.c.score - a.s.c.score);
    ranked.forEach((r, i) => (i < 18 ? shown : rest).push(r.ret));
  }
  console.log(
    `\ntop-18 cut (what reaches the analyst): median ${pct(median(shown))} on ${shown.length}` +
      ` · rest ${pct(median(rest))} on ${rest.length}`,
  );

  const rets = rows.map((r) => r.ret);
  console.log(`\nrank correlation with forward return`);
  console.log(`  ${"score (composite)".padEnd(20)}${rho(spearman(rows.map((r) => r.s.c.score), rets))}`);
  const ranked = FEATURES.map(
    (f) => [f, spearman(rows.map((r) => Number(r.s.c[f] ?? 0)), rets)] as const,
  ).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  for (const [f, r] of ranked) console.log(`  ${f.padEnd(20)}${rho(r)}`);
  console.log(
    `\nρ is Spearman on ${rows.length} rows: +1 perfect ranking, 0 none, −1 inverted. Anything` +
      ` inside ±0.05 here is indistinguishable from noise at this sample size.\n`,
  );
}

async function main(): Promise<void> {
  const arg = (k: string, d: number): number => {
    const v = process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
    return v === undefined || Number.isNaN(Number(v)) ? d : Number(v);
  };
  const minAge = arg("min-age", 0.25);
  const maxAge = arg("max-age", 1);
  const limit = arg("limit", 300);

  if (!soundingCount()) {
    console.log(`No soundings recorded yet. Run the agent for a few cycles first.`);
    return;
  }
  if (limit > 0) await resolve(minAge, maxAge, limit);
  report(minAge, maxAge);
}

if (process.argv[1]?.endsWith("calibrate.ts")) await main();
