import { toCandidate } from "../domain/candidates.ts";
import { refineQuery } from "../domain/config.ts";
import { runGates, score } from "../domain/gates.ts";
import { short } from "../domain/num.ts";
import { store } from "../data/store.ts";
import * as gmgn from "../market/gmgn.ts";
import type { Candidate } from "../domain/types.ts";

/**
 * Step 1 of a cycle, and the whole search: only what this file surfaces can ever be bought.
 * Three ranking feeds are fetched together, deduped into one row per address, gated and scored.
 *
 * The sweep applies no floor of its own — the dashboard's Refine panel is the only thing that
 * narrows these feeds, and a blank Refine means an unfiltered feed. Structural quality is
 * `score()`'s job and the operator's, so a hardcoded default here would be a gate wearing a
 * different name.
 */

type Feed = [rows: Record<string, any>[], source: string];

const LIMIT = 40;

/**
 * Every feed's rows deduped into one candidate per address. The merge order is the caller's and
 * it matters: the 1h rank feed defines the window the numbers cover.
 */
export function mergeFeeds(feeds: Feed[]): Candidate[] {
  const seen = new Map<string, Candidate>();
  for (const [rows, source] of feeds) {
    for (const r of rows) {
      const c = toCandidate(r, source);
      if (!c.address) continue;
      const key = c.address.toLowerCase();
      const prior = seen.get(key);
      // A token surfacing in more than one feed is a mild confirmation, so keep both labels —
      // but only once each.
      if (prior) {
        if (!prior.source.split("+").includes(source)) prior.source = `${prior.source}+${source}`;
      } else seen.set(key, c);
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
      .trending(cfg.chain, { interval: "1h", limit: LIMIT, refine: refineQuery(cfg.refine) })
      .then((r): Feed => [r, "trending-1h"])
      .catch((e): Feed => {
        store.log("warn", `Trending feed failed: ${short(e)}`);
        return [[], "trending-1h"];
      }),
    gmgn
      .trending(cfg.chain, { interval: "5m", limit: LIMIT, refine: refineQuery(cfg.refine) })
      .then((r): Feed => [r, "trending-5m"])
      .catch((e): Feed => {
        store.log("warn", `Trending 5m feed failed: ${short(e)}`);
        return [[], "trending-5m"];
      }),
  ];
  if (cfg.chain === "sol" || cfg.chain === "bsc" || cfg.chain === "robinhood")
    feeds.push(
      gmgn
        .trenches(cfg.chain, "completed", LIMIT, refineQuery(cfg.refine, "trenches"))
        .then((r): Feed => [r, "graduated"])
        .catch((e): Feed => {
          store.log("warn", `Graduated feed failed: ${short(e)}`);
          return [[], "graduated"];
        }),
    );

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
