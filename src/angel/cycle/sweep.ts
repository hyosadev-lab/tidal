import { toCandidate } from "../domain/candidates.ts";
import { refineQuery } from "../domain/config.ts";
import { runGates, score } from "../domain/gates.ts";
import { num, short } from "../domain/num.ts";
import { store } from "../data/store.ts";
import * as gmgn from "../market/gmgn.ts";
import type { Candidate } from "../domain/types.ts";

/**
 * Step 1 of a cycle, and the whole search: only what this file surfaces can ever be bought.
 * Several GMGN feeds are fetched together, deduped into one row per address, gated and scored.
 *
 * The sweep applies no floor of its own — the dashboard's Refine panel is the only thing that
 * narrows these feeds, and a blank Refine means an unfiltered feed. Structural quality is
 * `score()`'s job and the operator's, so a hardcoded default here would be a gate wearing a
 * different name.
 */

type Feed = [rows: Record<string, any>[], source: string];

/**
 * The signal types the sweep asks for, and the label each one leaves on a candidate. GMGN
 * documents the route as "price spikes, smart money buys, large buys, Dex ads, CTO events, and
 * more" but publishes no number-to-event mapping, so 3 and 13 keep their type number as their
 * name rather than a guess: measured, a 13 row is a large, established token that KOL-tagged
 * wallets hold, and a 3 row is small and often community-takeover flagged. What decides
 * membership here is overlap with the rank feeds, since nothing else survives the merge —
 * against one live sweep: 3 → 20/50, 11 → 18/50, 12 → 17/41, 6 → 12/46, 13 → 9/28. Type 7 (ATH)
 * managed 1/50 and stays out; the queryable range is 1–13 and 17–20 (14–16 the API refuses).
 */
const ALERTS: [type: number, label: string][] = [
  [12, "smart-money"],
  [6, "price-spike"],
  [3, "alert-3"],
  [13, "alert-13"],
];

/**
 * Every label above. No signal type carries flow — `volume_*`, `swaps_*` and `buys_*` come back
 * zero on all of them — so a row the rank feeds never surfaced has nothing to judge, and
 * `mergeFeeds` keeps the label while throwing the row away.
 */
const SIGNAL_LABELS = new Set(ALERTS.map(([, label]) => label));

/**
 * Every feed's rows deduped into one candidate per address. The merge order is the caller's and
 * it matters: the 1h rank feed defines the window the numbers cover, and the signal feeds run
 * last because they can only tag rows the rank feeds already produced.
 */
export function mergeFeeds(feeds: Feed[]): Candidate[] {
  const seen = new Map<string, Candidate>();
  for (const [rows, source] of feeds) {
    for (const r of rows) {
      const c = toCandidate(r, source);
      if (!c.address) continue;
      const key = c.address.toLowerCase();
      const prior = seen.get(key);
      // A signal is a confirmation, not a source: it fires on an event, reports no flow, and
      // may tag a trending or graduated row — it may not put one into the sweep on its own.
      // Nothing of the row survives but the label; the numbers stay the rank feed's.
      if (!prior && SIGNAL_LABELS.has(source)) continue;
      // A token surfacing in more than one feed is a mild confirmation, so keep both labels —
      // but only once each. The signal route returns one row per alert, so a token three smart
      // wallets bought arrives three times, and appending blindly made one feed read as three.
      if (prior) {
        if (!prior.source.split("+").includes(source)) prior.source = `${prior.source}+${source}`;
      } else seen.set(key, c);
      // The one number worth keeping off an alert row before it is thrown away: what the market
      // cap was when the alert fired. First one wins — the route returns newest first and
      // `ALERTS` asks for smart money first, so a token several alerts tagged reports the most
      // recent smart-money trigger rather than whichever type happened to land last.
      if (prior && SIGNAL_LABELS.has(source) && prior.triggerMcUsd === null) prior.triggerMcUsd = c.triggerMcUsd;
      // The 5m feed reports the same columns over a five-minute window, and nearly every row of
      // it is also in the 1h feed — so keeping only the first row seen dropped exactly the
      // numbers an acceleration test needs. Carry them alongside the hourly ones instead. On a
      // row this feed alone surfaced there is no hourly baseline — both windows are then the
      // same five minutes, and `seen_in` is what tells the analyst so.
      if (source === "trending-5m") {
        const t = prior ?? c;
        t.buys5m = c.buys;
        t.sells5m = c.sells;
        t.volume5mUsd = c.volume1hUsd;
      }
    }
  }
  return [...seen.values()];
}

export async function gatherCandidates(): Promise<Candidate[]> {
  const cfg = store.config;

  // The sweep applies no floor of its own: Refine is the only thing that narrows these feeds,
  // and an empty Refine means an unfiltered feed. That is the point — structural quality is
  // `score()`'s job and the operator's, so a hardcoded default here would be a gate wearing a
  // different name. Expect more noise per cycle when Refine is blank.
  const feeds: Promise<Feed>[] = [
    gmgn
      .trending(cfg.chain, { interval: "1h", limit: 50, refine: refineQuery(cfg.refine) })
      .then((r): Feed => [r, "trending-1h"])
      .catch((e): Feed => {
        store.log("warn", `Trending feed failed: ${short(e)}`);
        return [[], "trending-1h"];
      }),
    gmgn
      .trending(cfg.chain, { interval: "5m", limit: 30, refine: refineQuery(cfg.refine) })
      .then((r): Feed => [r, "trending-5m"])
      .catch((): Feed => [[], "trending-5m"]),
  ];
  if (cfg.chain === "sol" || cfg.chain === "bsc")
    feeds.push(
      gmgn
        .trenches(cfg.chain, "completed", 40, refineQuery(cfg.refine, "trenches"))
        .then((r): Feed => [r, "graduated"])
        .catch((): Feed => [[], "graduated"]),
    );
  // Alerts rather than ranks, and all of `ALERTS` rides one request: a group is a filter set
  // inside the same POST and the route bills per call, not per group, so a type past the first
  // is free on the bucket. Split the rows apart by `signal_type` on the way out, or a price
  // spike would arrive wearing the smart-money label. Refine reaches this route through market
  // cap only; the rest of the panel does not apply.
  const mc = { mc_min: cfg.refine["marketCapMin"], mc_max: cfg.refine["marketCapMax"] };
  const alerts = gmgn
    .signals(cfg.chain, ALERTS.map(([type]) => ({ signal_type: [type], ...mc })))
    .catch((): Record<string, any>[] => []);
  for (const [type, label] of ALERTS)
    feeds.push(alerts.then((rows): Feed => [rows.filter((r) => num(r["signal_type"]) === type), label]));

  // Fetched together, merged in a fixed order. `mergeFeeds` keeps the first row it sees for an
  // address, so merging as they landed left a race deciding whether `volume1hUsd` held an hour or
  // five minutes; the 1h feed goes first for that reason, and the 5m rows arrive knowing they are
  // a second window on a row that already exists.
  const all = mergeFeeds(await Promise.all(feeds));
  for (const c of all) {
    c.gateFailures = runGates(c);
    c.score = c.gateFailures.length ? 0 : score(c);
  }
  return all.sort((a, b) => b.score - a.score);
}
