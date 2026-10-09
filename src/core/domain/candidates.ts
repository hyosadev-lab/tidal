import type { Candidate } from "./types.ts";
import { num, numOrNull, truthy } from "./num.ts";

/**
 * A GMGN feed row becomes a Candidate here, and only here. Everything downstream reads the
 * shape this file produces rather than the wire's, which is what keeps the two feeds' disagreeing
 * column names (`bundler_rate` / `bundler_trader_amount_rate`, `buys` / `buys_24h`) from leaking
 * into the rules. A field only one feed reports is `number | null` on purpose: `num()` would
 * report "not measured" as a clean zero, and those are opposite readings.
 */

/** Normalise a `market trending` / `market trenches` row into our own shape. */
export function toCandidate(r: Record<string, any>, source: string): Candidate {
  const created = num(r.creation_timestamp ?? r.created_timestamp ?? r.open_timestamp);
  const ageMinutes = created > 0 ? (Date.now() / 1000 - created) / 60 : 0;
  const supply = num(r.total_supply);
  const mcap = num(r.market_cap ?? r.usd_market_cap);
  // Trenches rows carry a market cap and a supply but no price; the other feeds
  // carry a price. Derive the missing one rather than failing the "no price" gate
  // on every launchpad graduate.
  const price = num(r.price) || (mcap > 0 && supply > 0 ? mcap / supply : 0);
  return {
    address: String(r.address ?? r.token_address ?? ""),
    symbol: String(r.symbol ?? "?").slice(0, 24),
    name: String(r.name ?? "").slice(0, 60),
    priceUsd: price,
    marketCapUsd: mcap || price * supply,
    liquidityUsd: num(r.liquidity),
    volume1hUsd: num(r.volume ?? r.volume_1h ?? r.volume_24h),
    // GMGN sends these already in percent (16.6 = +16.6%), unlike rug_ratio / top_10_holder_rate.
    change5mPct: num(r.price_change_percent5m),
    change1hPct: num(r.price_change_percent1h ?? r.price_change_percent),
    change1mPct: numOrNull(r.price_change_percent1m),
    // `swaps_24h` included for the same reason `volume_24h` is: without it every graduated
    // row reports zero trades, which reads as a dead token rather than a different window.
    swaps1h: num(r.swaps ?? r.swaps_1h ?? r.swaps_24h),
    // Counts over whatever window the row itself covers — `swaps`/`buys`/`sells` on the rank
    // feed, `*_24h` on trenches. The two feeds do not agree on a window and never have; this
    // pair is here to show the buy/sell split, not to be compared across sources.
    buys: numOrNull(r.buys ?? r.buys_24h),
    sells: numOrNull(r.sells ?? r.sells_24h),
    // Filled by the sweep from the 5m feed's copy of this row, not from the row in hand:
    // a single row only ever carries one window.
    buys5m: null,
    sells5m: null,
    volume5mUsd: null,
    // Only trenches reports it, and only over 24h.
    netBuyUsd: numOrNull(r.net_buy_24h),
    holderCount: num(r.holder_count),
    smartDegenCount: num(r.smart_degen_count),
    renownedCount: num(r.renowned_count),
    rugRatio: num(r.rug_ratio),
    top10HolderRate: num(r.top_10_holder_rate ?? r.top_holder_rate),
    devHolding: String(r.creator_token_status ?? "") === "creator_hold",
    // The share the dev actually holds, where `devHolding` is only whether they hold at all.
    devHoldRate: numOrNull(r.dev_team_hold_rate ?? r.creator_balance_rate),
    // Each feed measures these under its own name, and neither carries the other's.
    insiderRate: numOrNull(r.insider_rate ?? r.suspected_insider_hold_rate),
    bundlerRate: numOrNull(r.bundler_rate ?? r.bundler_trader_amount_rate),
    // `gas_fee` on the rank feed, `total_fee` on trenches — different meters, same idea.
    feeUsd: numOrNull(r.gas_fee ?? r.total_fee),
    isWashTrading: truthy(r.is_wash_trading),
    isHoneypot: truthy(r.is_honeypot),
    ageMinutes,
    launchpad: String(r.launchpad_platform ?? r.launchpad ?? ""),
    source,
    gateFailures: [],
    score: 0,
  };
}

/**
 * The set of addresses the analyst is allowed to buy this cycle.
 *
 * The sweep is the whole search: only what `gatherCandidates` surfaced can be bought. The
 * analyst can research any token it likes with the read-only tools, but a name it turns up
 * that way has never been through `toCandidate` or the gates, so there is no candidate to
 * size, no entry liquidity to record and nothing to check — naming it spends a slot on a
 * refusal. `blocked` carries the held, cooled-down and blacklisted addresses, lowercased.
 */
/**
 * The analyst's next batch: every eligible row that is due, in the pool's order (best score
 * first). `dueAt` maps a lowercased address to when the analyst asked to see it again — a token
 * never judged is due now, which is what gets a new arrival analysed straight after the fetch
 * that carried it. `unavailable` is the store's held / cooldown / blacklist.
 */
export function dueNow(
  pool: Candidate[],
  dueAt: Map<string, number>,
  now: number,
  unavailable: (address: string) => unknown,
): Candidate[] {
  return pool.filter(
    (c) => !c.gateFailures.length && !unavailable(c.address) && now >= (dueAt.get(c.address.toLowerCase()) ?? 0),
  );
}

export function buyableSet(eligible: Candidate[], blocked: Set<string>): Map<string, Candidate> {
  const out = new Map<string, Candidate>();
  for (const c of eligible) {
    const key = c.address.toLowerCase();
    if (!key || out.has(key)) continue;
    if (c.gateFailures.length || blocked.has(key)) continue;
    out.set(key, c);
  }
  return out;
}
