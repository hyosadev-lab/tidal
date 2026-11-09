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
 * 30 SOL shallower than its virtual reserve) or a PumpSwap pool (about 17.5) the impact is
 * overstated; the measured gap carries it.
 * Returns the PnL % on cost and the point where nothing was left held, or null with no point to buy at. Pure.
 */
export function replayTrade(points: Point[], from: number, plan: ExitPlan, sizeSol: number, rug: boolean): { pnl: number; out: number } | null {
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
  let out = points.length - 1;
  for (let i = e + 1; i < points.length && held > 1e-9; i++) {
    const p = points[i];
    if (!p) continue;
    last = p;
    out = i;
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
  return { pnl: ((got - sizeSol) / sizeSol) * 100, out };
}

/** `replayTrade`'s PnL % alone. */
export const replay = (points: Point[], from: number, plan: ExitPlan, sizeSol: number, rug: boolean): number | null =>
  replayTrade(points, from, plan, sizeSol, rug)?.pnl ?? null;

export type Calibration = { n: number; agree: number; gapPct: number | null };

/** Each closed position's replay against its real result, computed once: neither ever changes. Per ledger. */
const sims = new Map<number, { sim: number; real: number } | null>();
let simsOf: unknown = null;

/**
 * Every position closed by its own exit rules, replayed on its decision's track with the plan it
 * ran: its exit_rules and the time stop, drain and size its buy kept, whatever Settings version it
 * was bought under or none (it scores the replay, not a Settings). `agree` counts the same sign of
 * result; `gapPct` is the mean of replay − real, the friction every test then charges. Each
 * position is replayed once, so the dashboard's read stays cheap as trades pile up.
 */
export function calibration(): Calibration {
  const rows = db
    .prepare(
      `select p.id from positions p join shadow_tracks s on s.decision_id = p.decision_id
       where p.status = 'closed' and p.close_reason in ('tp', 'sl', 'time', 'health')
         and p.time_stop_min is not null and p.drain_pct is not null and p.size_sol is not null
         and s.end_reason in ('done', 'rug') and s.path is not null
       order by p.id`,
    )
    .all() as { id: number }[];
  const one = db.prepare(
    `select p.id, p.opened_at, p.cost_usd, p.time_stop_min, p.drain_pct, p.size_sol, s.started_at, s.path, s.end_reason,
       (select sum(pnl_usd) from trades t where t.position_id = p.id and t.side = 'sell') pnl
     from positions p join shadow_tracks s on s.decision_id = p.decision_id where p.id = ?`,
  );
  if (simsOf !== db) (sims.clear(), (simsOf = db));
  const rulesOf = db.prepare("select kind, at_pct at, sell_pct sell from exit_rules where position_id = ? order by seq");
  let agree = 0;
  let n = 0;
  let gap = 0;
  for (const { id } of rows) {
    if (!sims.has(id)) {
      const r = one.get(id) as {
        opened_at: number; cost_usd: number; time_stop_min: number; drain_pct: number; size_sol: number; started_at: number; path: string; end_reason: string; pnl: number | null;
      };
      const plan = { rules: rulesOf.all(id) as Rule[], timeMin: r.time_stop_min, drainPct: r.drain_pct };
      const sim = replay(JSON.parse(r.path), Math.round((r.opened_at - r.started_at) / STEP_MS), plan, r.size_sol, r.end_reason === "rug");
      sims.set(id, sim === null || !(r.cost_usd > 0) ? null : { sim, real: ((r.pnl ?? 0) / r.cost_usd) * 100 });
    }
    const x = sims.get(id);
    if (!x) continue;
    n++;
    if (x.sim > 0 === x.real > 0) agree++;
    gap += x.sim - x.real;
  }
  return { n, agree, gapPct: n ? gap / n : null };
}
