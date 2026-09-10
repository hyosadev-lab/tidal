import type { Candidate } from "./types.ts";
import { num, truthy } from "./num.ts";

/**
 * What refuses a candidate outright, and what ranks the ones left. Deterministic and pure:
 * the model ranks nothing that has not already passed through here, and can never reverse a
 * refusal. See `positions.ts` for the same split applied to sizing and exits.
 */

/**
 * The pre-trade security refusal, checked once per entry against `token_security` — the only
 * route that answers these reliably. Feed rows carry the same field names but `trenches`
 * leaves them unpopulated, and reading its `false` as a failure would kill the whole feed.
 *
 * Three things are checked:
 *   • buy / sell tax above 10% — every chain. A token you can buy and sell but only at a 40%
 *     haircut is not a honeypot and no gate in the GMGN criteria table covers it; the
 *     threshold is that table's own 🔴 band for `buy_tax` / `sell_tax`. Absent fields read as
 *     0, as they do on Solana, where the concept does not exist.
 *   • mint / freeze authority — Solana only. A live mint authority lets the creator print
 *     supply on top of you; a live freeze authority lets them freeze the account so you can
 *     never sell. Solana launchpads revoke both at creation, so in practice this only
 *     catches tokens that were not launched that way. Cheap backstop, not a filter.
 *   • liquidity burn — Solana only. `burn_status: "burn"` means the LP tokens are gone and
 *     the deployer cannot pull the pool out from under the position. This one genuinely
 *     varies.
 *
 * The last two are Solana-scoped on purpose: mint and freeze authority do not exist on EVM,
 * and EVM liquidity is usually *locked* rather than burned, which the burn fields do not
 * describe.
 *
 * Unknown is not a pass. If the response cannot be read or carries neither answer, the
 * caller refuses the entry: these are exactly the properties worth being sure about.
 */
export function securityRisk(sec: Record<string, any> | null, chain: string): string {
  if (!sec) return "could not read token security";

  const reasons: string[] = [];
  if (num(sec.buy_tax) > 0.1 || num(sec.sell_tax) > 0.1)
    reasons.push(`tax ${Math.round(Math.max(num(sec.buy_tax), num(sec.sell_tax)) * 100)}% > 10%`);
  if (chain !== "sol") return reasons.join(", ");

  const { renounced_mint: mint, renounced_freeze_account: freeze } = sec;
  if (mint === undefined && freeze === undefined) reasons.push("security response carried no renounce status");
  else {
    if (!truthy(mint)) reasons.push("mint authority still live");
    if (!truthy(freeze)) reasons.push("freeze authority still live");
  }

  const status = String(sec.burn_status ?? "").toLowerCase();
  const ratio = num(sec.burn_ratio, -1);
  if (!status && ratio < 0) reasons.push("liquidity burn status unknown");
  else if (status !== "burn" && !(ratio > 0)) reasons.push("liquidity not burned — the deployer can still pull the pool");

  return reasons.join(", ");
}

/**
 * Hard gates. Any failure disqualifies — no weighting, no model override.
 *
 * What is left is only what a token cannot be under any thesis: fake flow, a token you
 * cannot sell, and rows we cannot read. The graded properties from GMGN's 🔴 Skip column —
 * smart-money count, rug_ratio, top-10 concentration, pool depth, dev still holding — no
 * longer gate. They are still read, still scored by `score()`, still shown to the analyst,
 * and still steerable per-feed from the dashboard's Refine panel; they are simply no longer
 * a refusal. That moves the call on a thin pool or a concentrated holder set from this
 * function to the analyst and the operator.
 *
 * Worth being explicit about what that costs: a candidate with zero smart money, a 0.9
 * rug_ratio, 90% in the top ten and a $2k pool now reaches the analyst, and only the analyst
 * and the Refine filters stand between it and a position. `securityRisk` is unchanged and
 * still refuses honeypot-equivalents, high tax, live mint/freeze authority and unburned
 * liquidity before any entry, on every chain.
 *
 * Takes no config: there is no operator input here, by design.
 */
export function runGates(c: Candidate): string[] {
  const f: string[] = [];

  if (c.isWashTrading) f.push("wash trading");

  // is_honeypot is EVM-only: on Solana it arrives empty, so this is inert there by design —
  // securityRisk covers the equivalent Solana failure modes before entry.
  if (c.isHoneypot) f.push("honeypot");

  // ── data integrity, not policy ──
  if (!c.address) f.push("no address");
  if (c.priceUsd <= 0) f.push("no price");

  return f;
}

/**
 * How often each gate fired across one sweep, busiest first: `wash 12 · no 3 · honeypot 1`.
 *
 * Grouped on the first word of the failure string, since the rest carries the token's own
 * numbers. That merges `no address` and `no price` into one `no` bucket — acceptable, both are
 * meant to be zero. A token failing several gates counts once per gate, so the numbers sum to
 * more than the rejects.
 */
export function gateTally(candidates: Candidate[]): string {
  const counts = new Map<string, number>();
  for (const c of candidates)
    for (const f of c.gateFailures) {
      const key = f.split(" ")[0] ?? f;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`)
    .join(" · ");
}

/**
 * 0–100 conviction from structure alone, before the model looks at it.
 *
 * The break points that come from GMGN's published bands are marked below; every weight is
 * judgement. `npm run calibrate` is what turns that into a measurement — it re-prices past
 * soundings and reports each term's rank correlation with the forward return. Change a weight
 * because that report says to, not because a number here looks tidy.
 *
 * A term also has to *rank* to earn its place, which is a separate question from whether it
 * points the right way and needs no forward return to answer. Measured over 2465 recorded
 * candidates, three terms fired for nearly every row and so only added a constant: top-10
 * holder rate (spread 1.2–3.6 of a possible 6), `swaps1h > 300` (85% of rows, and turnover
 * already reads the same flow), and `holderCount > 500` (19% of rows, 0.6 points on average).
 * Dropping all three moved 26 rows across the top-18 cut in 42 cycles. They are gone; adding
 * one back means showing it changes the order, not that it sounds relevant.
 */
export function score(c: Candidate): number {
  let s = 0;

  // Smart money is the single strongest prior in this dataset.
  s += Math.min(25, c.smartDegenCount * 6);
  s += Math.min(8, c.renownedCount * 3);

  // Momentum, but the reward curve turns down once a move is already extended:
  // buying +400% in an hour is buying someone else's exit.
  // The turn is at +120%; the project's own written heuristic was +150%.
  // In practice this is a penalty far more often than a reward — 70% of scanned rows arrive
  // already past +120%, so the term averages -1.3 points. That is the sweep's doing, not a
  // bug here, but read the curve as "how extended is this" rather than "how strong".
  const m = c.change1hPct;
  s += m <= 0 ? 0 : m < 120 ? (m / 120) * 18 : Math.max(-16, 18 - (m - 120) / 25);
  if (c.change5mPct > 0 && c.change5mPct < 40) s += 5;

  // Depth: you need to be able to get out at size. Zero at $10k — GMGN's published Skip floor.
  s += Math.min(14, Math.log10(Math.max(1, c.liquidityUsd / 10_000)) * 9);

  // Turnover — real two-way flow rather than a single whale print.
  const turnover = c.marketCapUsd > 0 ? c.volume1hUsd / c.marketCapUsd : 0;
  s += Math.min(12, turnover * 30);

  // Structure. 0.3 is GMGN's published Skip line for rug_ratio (their bands are Pass < 0.2,
  // Skip > 0.5).
  s += (1 - Math.min(1, c.rugRatio / 0.3)) * 8;

  // Age: too new is unpriced, very old memecoins are usually done.
  if (c.ageMinutes > 60 && c.ageMinutes < 2880) s += 4;

  return Math.max(0, Math.min(100, Math.round(s)));
}
