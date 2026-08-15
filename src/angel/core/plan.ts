import { num, numOrNull, sanitizeStrategy } from "./config.ts";
import type { Candidate, Position, StrategyRule, TradeConfig } from "./types.ts";

/**
 * THE TRADING PLAN
 *
 * Split by design:
 *   • Gates, sizing and exits are deterministic code. They run every 30s whether or
 *     not the model is reachable, in budget, or having a good day.
 *   • The model only ranks what already passed the gates and writes the thesis.
 *     It can veto a trade or ask for an early exit — it can never widen a limit.
 *
 * A position must never depend on an LLM call succeeding in order to be closed.
 */

const truthy = (v: unknown): boolean => {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v === 1;
  if (typeof v === "string") return ["1", "yes", "true"].includes(v.trim().toLowerCase());
  return false;
};

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
 */
export function score(c: Candidate): number {
  let s = 0;

  // Smart money is the single strongest prior in this dataset.
  s += Math.min(25, c.smartDegenCount * 6);
  s += Math.min(8, c.renownedCount * 3);

  // Momentum, but the reward curve turns down once a move is already extended:
  // buying +400% in an hour is buying someone else's exit.
  // The turn is at +120%; the project's own written heuristic was +150%.
  const m = c.change1hPct;
  s += m <= 0 ? 0 : m < 120 ? (m / 120) * 18 : Math.max(-16, 18 - (m - 120) / 25);
  if (c.change5mPct > 0 && c.change5mPct < 40) s += 5;

  // Depth: you need to be able to get out at size. Zero at $10k — GMGN's published Skip floor.
  s += Math.min(14, Math.log10(Math.max(1, c.liquidityUsd / 10_000)) * 9);

  // Turnover — real two-way flow rather than a single whale print.
  const turnover = c.marketCapUsd > 0 ? c.volume1hUsd / c.marketCapUsd : 0;
  s += Math.min(12, turnover * 30);
  if (c.swaps1h > 300) s += 4;

  // Structure. 0.3 is GMGN's published Skip line for rug_ratio; the 0.4 below is judgement
  // (their bands are Pass < 0.2, Skip > 0.5).
  s += (1 - Math.min(1, c.rugRatio / 0.3)) * 8;
  s += (1 - Math.min(1, c.top10HolderRate / 0.4)) * 6;
  if (c.holderCount > 500) s += 3;

  // Age: too new is unpriced, very old memecoins are usually done.
  if (c.ageMinutes > 60 && c.ageMinutes < 2880) s += 4;

  return Math.max(0, Math.min(100, Math.round(s)));
}

/** USD to commit, scaled by conviction and clamped by the risk envelope. */
export function positionSize(cfg: TradeConfig, equity: number, cash: number, conviction: number): number {
  const base = equity * (cfg.riskPerTradePct / 100);
  const scaled = base * (0.6 + 0.4 * Math.min(1, Math.max(0, conviction) / 100));
  // Never commit the last of the cash — fees and the next stop-loss need headroom.
  return Math.max(0, Math.min(scaled, cash * 0.9));
}

export type ExitSignal = { percent: number; reason: string; kind: string };

/**
 * Mechanical exits, checked on every monitor tick. First match wins, hardest first.
 * Mutates `trailArmed` because arming is a one-way latch tied to the peak.
 */
export function evaluateExit(p: Position, cfg: TradeConfig): ExitSignal | null {
  if (p.lastPrice <= 0 || p.entryPrice <= 0) return null;
  const pnlPct = ((p.lastPrice - p.entryPrice) / p.entryPrice) * 100;
  const stop = p.stopLossPct || cfg.stopLossPct;

  // A position carrying its own rule set runs on those instead of the config's
  // stop / trail / ladder. The time stop below still applies either way.
  if (p.strategy?.length) {
    const hit = ruleExit(p, pnlPct, p.breakevenPct ?? 0);
    if (hit) return hit;
    return timeStop(p, cfg, pnlPct);
  }

  if (pnlPct <= -stop)
    return { percent: 100, reason: `stop-loss hit at ${pnlPct.toFixed(1)}%`, kind: "stop" };

  if (pnlPct >= cfg.trailArmPct) p.trailArmed = true;

  if (p.trailArmed) {
    const giveback = ((p.peakPrice - p.lastPrice) / p.peakPrice) * 100;
    if (giveback >= cfg.trailGivebackPct)
      return {
        percent: 100,
        reason: `trailing stop — gave back ${giveback.toFixed(1)}% from peak (still +${pnlPct.toFixed(1)}%)`,
        kind: "trail",
      };
  }

  // Walk the ladder from the top so a fast spike fills the highest rung reached.
  for (let i = cfg.takeProfit.length - 1; i >= 0; i--) {
    const rung = cfg.takeProfit[i];
    if (!rung || p.filledRungs.includes(i)) continue;
    if (pnlPct >= rung.at)
      return { percent: rung.sell, reason: `take-profit rung ${i + 1} at +${pnlPct.toFixed(1)}%`, kind: `tp${i}` };
  }

  return timeStop(p, cfg, pnlPct);
}

function timeStop(p: Position, cfg: TradeConfig, pnlPct: number): ExitSignal | null {
  const ageMin = (Date.now() - p.openedAt) / 60_000;
  // "Under +8% after three hours is not working" means nothing if +8% is under the round trip:
  // on a small position the hurdle is the higher number and the one that decides.
  const floor = Math.max(cfg.timeStopMinPnlPct, p.breakevenPct ?? 0);
  if (ageMin >= cfg.timeStopMinutes && pnlPct < floor)
    return {
      percent: 100,
      reason: `time stop — ${Math.round(ageMin)}m in and only ${pnlPct.toFixed(1)}%, under the +${floor.toFixed(1)}% it has to clear`,
      kind: "time",
    };
  return null;
}

/**
 * The rule-set exits. Losses first, then trailing rules, then the highest take-profit reached,
 * so a spike between two ticks fills the top rung rather than the bottom one. Arming is derived
 * from `peakPrice` rather than latched, so several trailing rules can coexist.
 * Trailing rules never fire underwater — that half of the range is the stop loss's.
 */
function ruleExit(p: Position, pnlPct: number, breakeven: number): ExitSignal | null {
  const rules = p.strategy ?? [];
  const peakPnl = peakPct(p);
  const giveback = p.peakPrice > 0 ? ((p.peakPrice - p.lastPrice) / p.peakPrice) * 100 : 0;
  const live = (i: number) => !p.filledRungs.includes(i);
  const sig = (i: number, reason: string): ExitSignal => ({ percent: rules[i]!.sell, reason, kind: `rule${i}` });

  // The stop owns the downside wherever the model happened to list it. Checked in its own pass
  // ahead of the trails, because a tick can satisfy both — memecoins gap 50% between two 30s
  // polls — and whichever rule is reached first wins the tick. Interleaved, a trailing rule
  // written above the `sl` took that tick and sold only its own (often partial) percent, and
  // the stop the rest of the plan was sized around fired a tick late, further down, on what
  // was left. That is the "the stop-loss never does anything" shape.
  for (let i = 0; i < rules.length; i++)
    if (rules[i]!.kind === "sl" && live(i) && pnlPct <= (rules[i]!.at ?? 0))
      return sig(i, `stop loss at ${pnlPct.toFixed(1)}%`);

  for (let i = 0; i < rules.length; i++) {
    const r = rules[i]!;
    // A trail only exits in profit: below break-even the position belongs to the stop loss.
    // Both trailing kinds, so the split stays the one the analyst is briefed on — a `ttp`
    // exempt from this fires underwater and shadows the stop exactly like a `tsl` would.
    // Break-even is the round trip, not zero: a trail that fires at +5% against a 9% hurdle
    // books a loss while calling itself profit protection, which is what this line always
    // meant to prevent and could not, back when the fees were assumed away.
    if (!live(i) || pnlPct <= breakeven) continue;
    if (r.kind === "tsl" && giveback >= (r.dd ?? Infinity))
      return sig(i, `trailing stop loss — gave back ${giveback.toFixed(1)}% from peak (still +${pnlPct.toFixed(1)}%)`);
    if (r.kind === "ttp" && peakPnl >= (r.at ?? Infinity) && giveback >= (r.dd ?? Infinity))
      return sig(i, `trailing take-profit — armed at +${r.at}%, gave back ${giveback.toFixed(1)}% (still +${pnlPct.toFixed(1)}%)`);
  }

  let best = -1;
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i]!;
    if (r.kind !== "tp" || !live(i) || pnlPct < (r.at ?? Infinity)) continue;
    if (best < 0 || (rules[best]!.at ?? 0) < (r.at ?? 0)) best = i;
  }
  return best < 0 ? null : sig(best, `take-profit at +${pnlPct.toFixed(1)}%`);
}

/**
 * The exit plan a new position will run on.
 *   fixed   → the operator's rows from the dashboard
 *   dynamic → the analyst's, sanitized to the same clamps
 * The model picks the shape, never the outer limit: a stop can't sit deeper than
 * `cfg.stopLossPct`, and a plan without one gets it appended. An unusable proposal
 * falls back to the config's stop / trail / ladder rather than to no exits at all.
 */
export function entryStrategy(cfg: TradeConfig, proposed: unknown): StrategyRule[] {
  const rules = cfg.fixedStrategy ? cfg.strategy : sanitizeStrategy(proposed, []);
  if (!rules.length) return [];
  const capped = rules.map((r) =>
    r.kind === "sl" ? { ...r, at: Math.max(r.at ?? -cfg.stopLossPct, -cfg.stopLossPct) } : r,
  );
  return capped.some((r) => r.kind === "sl")
    ? capped
    : [...capped, { kind: "sl" as const, at: -cfg.stopLossPct, sell: 100 }];
}

/**
 * The same plan, priced. `entryStrategy` writes the shape; this is what the fees allow of it,
 * applied once at entry when the position's size and the round-trip cost are both known.
 *
 * Three corrections, and the first two are the same fact seen from different ends:
 *
 * - A profit target below break-even is not a profit target. It is lifted to the hurdle — for a
 *   `ttp` that means the arm level from which a `dd`% giveback still lands above it, since the
 *   giveback is what the position actually exits at, not the arm.
 * - A target inside the token's own noise is not a target either, and this is the more expensive
 *   half. A rung is filled the moment the price *touches* it, so on an asset whose median
 *   one-minute high-low range is ~25%, a rung at +20% is reached by the first or second candle
 *   whatever the thesis said. Measured over one session of this agent's own trades: six of six
 *   positions carrying a rung filled it within 18-206 seconds, three of them minutes before the
 *   rest of the position ran to +43%, +182% and +30%, the other three minutes before it stopped
 *   out. `noiseFloor` is the operator's stop distance, which is the one statement of "how far
 *   this token moves against me before I call it wrong" already in the config — a plan that
 *   risks that much to make less than that much is inverted before fees are counted.
 * - A rung too small to be worth its own transaction is folded into the next one up. Each rung is
 *   a separate swap paying the flat chain fee again, so a four-rung ladder on a small position
 *   spends four times to leave what one sale would have left. Sizes are estimated at the price
 *   that triggers the rung, which is the price it would actually sell at.
 *
 * `sl` and `tsl` pass through: a stop is not optional, and a rule with no target cannot be priced.
 * Neither wants the noise floor either, for different reasons. Lifting an `sl` would deepen a loss
 * rather than protect a gain. A `tsl` is structurally immune to the problem the floor exists for —
 * it triggers on a giveback from the peak, and a noise spike moves the peak rather than the
 * trigger — while flooring it would be actively harmful: a trail held back from firing at +20%
 * does not get a better exit later, it falls through to the stop, since a giveback only ever
 * widens. That is also why `ruleExit`'s guard on the trailing rules stays at break-even.
 */
export function viableStrategy(
  rules: StrategyRule[],
  breakeven: number,
  minLeg: number,
  usd: number,
  noiseFloor: number,
): StrategyRule[] {
  if (!rules.length || !(usd > 0)) return rules;
  const out: StrategyRule[] = [];
  let carry = 0;
  let carriedTarget = 0;
  // Both floors are "below this a rule does not do what it is named"; the higher one binds.
  const base = Math.max(breakeven, Math.max(0, noiseFloor));

  for (const r of rules) {
    if (r.kind !== "tp" && r.kind !== "ttp") {
      out.push(r);
      continue;
    }
    // A `ttp` exits at peak × (1 - dd), so the arm has to clear the floor by the giveback.
    const floor = r.kind === "ttp" ? ((1 + base / 100) / (1 - (r.dd ?? 0) / 100) - 1) * 100 : base;
    const at = Math.round(Math.max(r.at ?? 0, floor) * 10) / 10;
    const sell = Math.min(100, r.sell + carry);
    if (usd * (sell / 100) * (1 + at / 100) < minLeg) {
      carry = sell;
      carriedTarget = Math.max(carriedTarget, at);
      continue;
    }
    carry = 0;
    out.push({ ...r, at, sell });
  }

  // Whatever never grew big enough to sell on its own still needs somewhere to go: one rung at
  // the highest target it reached, which is the ladder collapsing into the single leg it could
  // afford all along.
  if (carry > 0) out.push({ kind: "tp", at: carriedTarget, sell: carry });
  return out;
}

/** Live risk checks against fresh token data for a position we already hold. */
export function healthExit(
  p: Position,
  info: Record<string, any>,
  entryLiquidity: number,
): ExitSignal | null {
  const liq = num(info?.liquidity ?? info?.pool?.liquidity);
  if (entryLiquidity > 0 && liq > 0 && liq < entryLiquidity * 0.45)
    return { percent: 100, reason: `liquidity drained ${Math.round((1 - liq / entryLiquidity) * 100)}%`, kind: "health" };
  if (String(info?.is_honeypot ?? "").toLowerCase() === "yes")
    return { percent: 100, reason: "token turned honeypot", kind: "health" };
  return null;
}

/**
 * A slice smaller than this is noise, not a position: a rounding remainder GMGN's own fills
 * leave behind. Used two ways — a *remainder* this size means the position is closed, and a
 * *delta* this size against the wallet is not a sale worth booking.
 */
export const DUST_FRACTION = 0.02;

/** Nothing tradeable left: under $1 of value, or under `DUST_FRACTION` of what was bought. */
export function isDust(p: Position): boolean {
  return p.qty * p.lastPrice < 1 || p.qty <= p.originalQty * DUST_FRACTION;
}

export function pnlPct(p: Position): number {
  return p.entryPrice > 0 ? ((p.lastPrice - p.entryPrice) / p.entryPrice) * 100 : 0;
}

/**
 * The best the position ever showed, on the same gross-of-fees basis every exit rule is measured
 * on. One definition for both readers on purpose: the rules fire off this number, and the trade
 * record stores it so a fill can be checked against the target that was actually reachable.
 */
export function peakPct(p: Position): number {
  return p.entryPrice > 0 ? ((p.peakPrice - p.entryPrice) / p.entryPrice) * 100 : 0;
}
