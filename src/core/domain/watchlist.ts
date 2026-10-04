import type { Candidate, Chain, Decision, Watch } from "./types.ts";

/**
 * The watchlist's limits. The analyst decides what goes on it and what comes off; how many it
 * holds, how long a token may sit there and how long it must be watched before it can be bought
 * are decided here, in code — a prompt cannot hold a slot open forever or buy on first sight.
 */

/** Most tokens watched at once. */
export const WATCH_MAX = 3;
/** Minutes between watch ticks. */
export const WATCH_MINUTES = 5;
/**
 * Minutes a token must have been watched before it can be bought. Shorter than a tick on
 * purpose: a token is added partway through a sweep, so the first tick after it finds it a few
 * seconds short of a full interval — that tick must count, the one fired right behind the sweep
 * that added it must not.
 */
export const WATCH_MIN_MINUTES = 3;
/** Minutes after which an unbought token is dropped, so a dead watch cannot hold a slot. */
export const WATCH_TTL_MINUTES = 45;

const MAX_POINTS = 24;

/** Watched long enough to be bought. */
export const ripe = (w: Watch, now: number): boolean => now - w.addedAt >= WATCH_MIN_MINUTES * 60_000;

const same = (a: string, b: unknown): boolean => a.toLowerCase() === String(b ?? "").toLowerCase();

/**
 * A fresh price for a watched token. Market cap moves with it — supply is fixed, and
 * `broker.buy` derives the entry market cap from the pair. Looks under a minute apart (a sweep
 * and the tick behind it) share one point on the trail.
 */
export function observe(w: Watch, price: number, now: number): void {
  if (!(price > 0)) return;
  if (w.c.priceUsd > 0) w.c.marketCapUsd *= price / w.c.priceUsd;
  w.c.priceUsd = price;
  const last = w.prices[w.prices.length - 1];
  if (last && now - last.at < 60_000) last.price = price;
  else w.prices.push({ at: now, price });
  if (w.prices.length > MAX_POINTS) w.prices.splice(0, w.prices.length - MAX_POINTS);
}

/** Drop what timed out or can no longer be bought. `unavailable` is `store.unavailable`. */
export function pruneWatchlist(
  list: Watch[],
  now: number,
  chain: Chain,
  unavailable: (address: string) => string,
): { list: Watch[]; notes: string[] } {
  const notes: string[] = [];
  const kept = list.filter((w) => {
    const why =
      w.chain !== chain
        ? "the chain changed"
        : unavailable(w.c.address) ||
          (w.c.gateFailures.length ? `failed a gate (${w.c.gateFailures.join(", ")})` : "") ||
          (now - w.addedAt > WATCH_TTL_MINUTES * 60_000 ? `watched ${WATCH_TTL_MINUTES}m without an entry` : "");
    if (why) notes.push(`${w.c.symbol} dropped — ${why}.`);
    return !why;
  });
  return { list: kept, notes };
}

/**
 * The analyst's edits, applied. Removals first, so a token dropped in the same answer frees its
 * slot. Only a row from this sweep's eligible list can be added — it is the one that went
 * through `toCandidate` and the gates — and never past `WATCH_MAX`.
 */
export function reviseWatchlist(
  list: Watch[],
  watch: Decision["watch"],
  unwatch: Decision["unwatch"],
  eligible: Candidate[],
  chain: Chain,
  now: number,
): { list: Watch[]; notes: string[] } {
  const notes: string[] = [];
  const out = list.filter((w) => {
    const u = unwatch.find((x) => same(w.c.address, x?.address));
    if (u) notes.push(`${w.c.symbol} removed — ${String(u.reason ?? "no reason given").slice(0, 200)}`);
    return !u;
  });
  for (const x of watch) {
    const c = eligible.find((e) => !e.gateFailures.length && same(e.address, x?.address));
    const label = `${String(x?.symbol ?? "?").slice(0, 20)} (${String(x?.address ?? "no address").slice(0, 24)})`;
    if (!c) notes.push(`${label} not added — it is not an eligible row of this sweep.`);
    else if (out.some((w) => same(w.c.address, c.address))) continue;
    else if (out.length >= WATCH_MAX) notes.push(`${c.symbol} not added — the watchlist is full (${WATCH_MAX}).`);
    else {
      const note = String(x.note ?? "").slice(0, 300);
      out.push({ chain, c, addedAt: now, note, prices: [{ at: now, price: c.priceUsd }] });
      notes.push(`${c.symbol} added — ${note || "no note"}`);
    }
  }
  return { list: out, notes };
}
