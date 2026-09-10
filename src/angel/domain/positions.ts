import { sanitizeStrategy, tradeSize } from "./config.ts";
import type { Position, StrategyRule, TradeConfig } from "./types.ts";
import { num } from "./num.ts";

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

/**
 * USD to commit. A fixed amount of the native token, priced at `nativeUsd` — same size every
 * entry, whatever the conviction. Never commits the last of the cash: fees and the next
 * stop-loss need headroom, so a thin balance shrinks the buy (and the floor check skips it).
 */
export function positionSize(cfg: TradeConfig, cash: number, nativeUsd: number): number {
  return Math.max(0, Math.min(tradeSize(cfg) * nativeUsd, cash * 0.9));
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
  // A hard cap on holding time, not a performance test. It used to fire only on a position that
  // was also under a PnL floor, which meant a green one aged forever: measured on this ledger,
  // one ran 307m against a 60m setting and gave back a +226% peak to +3.7% before anything
  // could touch it. Whatever the position is doing at this age, it is done.
  if (ageMin < cfg.timeStopMinutes) return null;
  return {
    percent: 100,
    reason: `time stop — max hold ${Math.round(ageMin)}m reached at ${pnlPct.toFixed(1)}%`,
    kind: "time",
  };
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

