import { loadConfig } from "./config.ts";
import { db } from "./db.ts";
import { STEP_MS, type Point } from "./shadow.ts";

/**
 * Replays an exit plan on a shadow track's path, the way the exit loop runs it, and checks the
 * replay against every real trade that has a track of its own. Prices are the pool's, not fills:
 * the size impact comes off the stored reserve; fees and the rest are the measured gap.
 */

/** A rule as exit_rules holds it: `at` % vs the fill price, `sell` % of the original quantity. */
export type Rule = { kind: "tp" | "sl"; at: number; sell: number };
export type ExitPlan = { rules: Rule[]; timeMin: number; drainPct: number };

/** A point after the buy point this many steps (30s) late is too late to buy at. */
const ENTRY_STEPS = 15;

/**
 * One position replayed from point `from`: bought there for `sizeSol` at the pool price plus the
 * impact on that point's reserve, then every later point checked as exit.ts evaluates (stops,
 * then a liquidity drain against the first reserve, then the time stop, then take profits), each
 * sale at the point's price less its own impact. What is held when the path ends is sold at its
 * last point; after a rug it is worth nothing. The reserve is the real one, so on a curve (about
 * 30 SOL shallower than its virtual reserve) the impact is overstated; the measured gap carries it.
 * Returns the PnL % on cost, or null with no point to buy at. Pure.
 */
export function replay(points: Point[], from: number, plan: ExitPlan, sizeSol: number, rug: boolean): number | null {
  let e = Math.max(0, from);
  while (e < points.length && e <= from + ENTRY_STEPS && !points[e]) e++;
  const at = points[e];
  if (!at || e > from + ENTRY_STEPS || at[1] <= 0) return null;
  const entry = (1 + at[0] / 100) * (1 + sizeSol / at[1]); // price paid, relative to the track's first price
  const units = sizeSol / entry;
  const baseline = at[1];
  const armed = plan.rules.map((r) => ({ ...r }));
  let held = 100; // % of the original still held
  let got = 0; // SOL back

  const sellAt = (p: [number, number], pct: number) => {
    const f = Math.min(pct, held) / 100;
    const value = units * f * (1 + p[0] / 100);
    got += value * (p[1] / (p[1] + value)); // a constant-product pool's output for that much in
    held -= f * 100;
  };
  let last: [number, number] = at;
  for (let i = e + 1; i < points.length && held > 1e-9; i++) {
    const p = points[i];
    if (!p) continue;
    last = p;
    const pnl = ((1 + p[0] / 100) / entry - 1) * 100;
    const fire = (kind: "tp" | "sl", hit: (r: Rule) => boolean) => {
      const rs = armed.filter((r) => r.kind === kind && hit(r));
      for (const r of rs) armed.splice(armed.indexOf(r), 1);
      return rs.reduce((t, r) => t + r.sell, 0);
    };
    const stop = fire("sl", (r) => pnl <= r.at);
    if (stop) sellAt(p, stop);
    else if (p[1] < baseline * (1 - plan.drainPct / 100)) sellAt(p, 100);
    else if ((i - e) * STEP_MS >= plan.timeMin * 60_000) sellAt(p, 100);
    else {
      const take = fire("tp", (r) => pnl >= r.at);
      if (take) sellAt(p, take);
    }
  }
  if (held > 1e-9 && !rug) sellAt(last, held);
  return ((got - sizeSol) / sizeSol) * 100;
}

export type Calibration = { n: number; agree: number; gapPct: number | null };

let cache: { key: string; value: Calibration } | null = null;

/**
 * Every position closed by its own exit rules, replayed on its decision's track with the plan it
 * ran (its exit_rules) and the config in force when it opened. `agree` counts the same sign of
 * result; `gapPct` is the mean of replay − real, the friction every test then charges. Recomputed
 * only when a position closes.
 */
export function calibration(): Calibration {
  const rows = db
    .prepare(
      `select p.id, p.opened_at, p.cost_usd, s.started_at, s.path, s.end_reason,
         (select sum(pnl_usd) from trades t where t.position_id = p.id and t.side = 'sell') pnl
       from positions p join shadow_tracks s on s.decision_id = p.decision_id
       where p.status = 'closed' and p.close_reason in ('tp', 'sl', 'time', 'health')
         and s.end_reason in ('done', 'rug') and s.path is not null
       order by p.id`,
    )
    .all() as { id: number; opened_at: number; cost_usd: number; started_at: number; path: string; end_reason: string; pnl: number | null }[];
  const key = rows.map((r) => r.id).join(",");
  if (cache?.key === key) return cache.value;

  const configAt = db.prepare("select value from config_history where at <= ? order by at desc limit 1");
  const rulesOf = db.prepare("select kind, at_pct at, sell_pct sell from exit_rules where position_id = ? order by seq");
  const now = loadConfig();
  let agree = 0;
  let n = 0;
  let gap = 0;
  for (const r of rows) {
    const c = (configAt.get(r.opened_at) as { value: string } | undefined)?.value;
    const cfg = c ? { ...now, ...JSON.parse(c) } : now;
    const plan = { rules: rulesOf.all(r.id) as Rule[], timeMin: cfg.timeStopMinutes, drainPct: cfg.liquidityDrainPct };
    const sim = replay(JSON.parse(r.path), Math.round((r.opened_at - r.started_at) / STEP_MS), plan, cfg.sizeSol, r.end_reason === "rug");
    if (sim === null || !(r.cost_usd > 0)) continue;
    const real = ((r.pnl ?? 0) / r.cost_usd) * 100;
    n++;
    if (sim > 0 === real > 0) agree++;
    gap += sim - real;
  }
  const value = { n, agree, gapPct: n ? gap / n : null };
  cache = { key, value };
  return value;
}
