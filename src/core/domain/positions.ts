import { sanitizeStrategy, tradeSize } from "./config.ts";
import type { Position, StrategyRule, TradeConfig } from "./types.ts";
import { clamp, num } from "./num.ts";

/**
 * THE TRADING PLAN
 *
 * Split by design:
 *   • Gates, sizing and exits are deterministic code. They run every 5s whether or
 *     not the model is reachable, in budget, or having a good day.
 *   • The model only ranks what already passed the gates and writes the thesis.
 *     It can veto a trade or ask for an early exit — it can never widen a limit.
 *
 * A position must never depend on an LLM call succeeding in order to be closed.
 */

/**
 * The conviction an entry has to beat, strictly: 60 is refused, 61 buys. A risk limit, so it
 * lives here rather than in the prompt — the model is told the number, but `openEntries` is what
 * enforces it, and a model that omits `conviction` falls back to the row's structural `score`.
 */
export const CONVICTION_FLOOR = 60;

/**
 * USD to commit. A fixed amount of the native token, priced at `nativeUsd` — same size every
 * entry, whatever the conviction. Never commits the last of the cash: fees and the next
 * stop-loss need headroom, so a thin balance shrinks the buy (and the floor check skips it).
 */
export function positionSize(cfg: TradeConfig, cash: number, nativeUsd: number): number {
  return Math.max(0, Math.min(tradeSize(cfg) * nativeUsd, cash * 0.9));
}

export type ExitSignal = { percent: number; reason: string; kind: string };

/** Mechanical exits, checked on every monitor tick. First match wins, hardest first. */
export function evaluateExit(p: Position, cfg: TradeConfig): ExitSignal | null {
  if (p.lastPrice <= 0 || p.entryPrice <= 0) return null;
  const pnl = pnlPct(p);
  const stop = p.stopLossPct || cfg.stopLossPct;

  // A position carrying its own rule set runs on those instead of the config's
  // stop / ladder. The time stop below still applies either way.
  if (p.strategy?.length) {
    const hit = ruleExit(p, pnl);
    if (hit) return hit;
    return timeStop(p, cfg, pnl);
  }

  if (pnl <= -stop)
    return { percent: 100, reason: `stop-loss hit at ${pnl.toFixed(1)}%`, kind: "stop" };

  // Walk the ladder from the top so a fast spike fills the highest rung reached.
  for (let i = cfg.takeProfit.length - 1; i >= 0; i--) {
    const rung = cfg.takeProfit[i];
    if (!rung || p.filledRungs.includes(i)) continue;
    if (pnl >= rung.at)
      return { percent: rung.sell, reason: `take-profit rung ${i + 1} at +${pnl.toFixed(1)}%`, kind: `tp${i}` };
  }

  return timeStop(p, cfg, pnl);
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
 * The rule-set exits: stops first, then take-profits. A plan may carry several of each, and each
 * fires once. When one tick reaches more than one — memecoins gap 50% between two 30s polls —
 * the furthest one reached wins on both sides: the deepest stop, the highest take-profit. So a
 * gap through a staged stop sells what the last stage was sized to sell, not the first stage's
 * slice with the rest left for a tick later and further down.
 */
function ruleExit(p: Position, pnlPct: number): ExitSignal | null {
  const rules = p.strategy ?? [];
  const sig = (i: number, reason: string): ExitSignal => ({ percent: rules[i]!.sell, reason, kind: `rule${i}` });
  /** The live rule of `kind` whose level is reached and furthest from entry. */
  const furthest = (kind: "tp" | "sl"): number => {
    let best = -1;
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i]!;
      if (r.kind !== kind || p.filledRungs.includes(i) || r.at == null) continue;
      if (kind === "sl" ? pnlPct > r.at : pnlPct < r.at) continue;
      if (best < 0 || Math.abs(rules[best]!.at ?? 0) < Math.abs(r.at)) best = i;
    }
    return best;
  };

  const stop = furthest("sl");
  if (stop >= 0) return sig(stop, `stop loss at ${pnlPct.toFixed(1)}%`);
  const tp = furthest("tp");
  return tp < 0 ? null : sig(tp, `take-profit at +${pnlPct.toFixed(1)}%`);
}

/**
 * The exit plan a new position will run on.
 *   fixed   → the operator's rows from the dashboard
 *   dynamic → the analyst's, sanitized to the same clamps
 * The model picks the shape, never the outer limit: a stop can't sit deeper than
 * `cfg.stopLossPct`, and a plan whose stops do not cover the whole position gets one appended. An unusable proposal
 * falls back to the config's stop / ladder rather than to no exits at all.
 */
export function entryStrategy(cfg: TradeConfig, proposed: unknown): StrategyRule[] {
  const rules = cfg.fixedStrategy ? cfg.strategy : sanitizeStrategy(proposed, []);
  if (!rules.length) return [];
  const capped = rules.map((r) =>
    r.kind === "sl" ? { ...r, at: Math.max(r.at ?? -cfg.stopLossPct, -cfg.stopLossPct) } : r,
  );
  // Stops may be staged, so "has a stop" is not enough: if they sell less than the whole
  // position between them, the rest sits with no floor under it. One more covers it.
  const covered = capped.reduce((t, r) => t + (r.kind === "sl" ? r.sell : 0), 0);
  return covered >= 100 ? capped : [...capped, { kind: "sl" as const, at: -cfg.stopLossPct, sell: 100 }];
}

/**
 * The model's per-entry stop, which the legacy path (no rule set) runs on — in paper through
 * `evaluateExit`, in live as the `loss_stop` GMGN is handed. It may tighten the operator's stop,
 * never deepen it. The floor keeps a model stop out of the token's own noise, unless the operator
 * already set one tighter than that.
 */
export const entryStop = (cfg: TradeConfig, proposed: unknown): number =>
  clamp(proposed, Math.min(10, cfg.stopLossPct), cfg.stopLossPct, cfg.stopLossPct);

/**
 * The same plan, priced. `entryStrategy` writes the shape; this is what the fees allow of it,
 * applied once at entry when the position's size and the round-trip cost are both known.
 *
 * Three corrections, and the first two are the same fact seen from different ends:
 *
 * - A profit target below break-even is not a profit target. It is lifted to the hurdle.
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
 * `sl` passes through: a stop is not optional, and lifting one would deepen a loss rather than
 * protect a gain.
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
  const floor = Math.max(breakeven, Math.max(0, noiseFloor));

  for (const r of rules) {
    if (r.kind !== "tp") {
      out.push(r);
      continue;
    }
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
export function healthExit(p: Position, info: Record<string, any>): ExitSignal | null {
  const entryLiquidity = p.entryLiquidityUsd;
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
 * on. The trade record stores it, so a rung that never filled can be checked against how far
 * the price actually got.
 */
export function peakPct(p: Position): number {
  return p.entryPrice > 0 ? ((p.peakPrice - p.entryPrice) / p.entryPrice) * 100 : 0;
}

