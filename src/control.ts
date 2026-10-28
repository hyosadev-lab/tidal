import type { Config } from "./config.ts";
import { db } from "./db.ts";
import { log } from "./log.ts";
import { buyingPaused, lossDay, openPositions, sell } from "./trade.ts";

/**
 * Run control, as the dashboard's Start / Stop / Resume set it, stored in `settings` under 'run'.
 * Every process starts stopped (`bootStopped`): nothing buys or sells until Start is pressed.
 * `pausedAt` is the daily-loss pause, which stops buying only; exits keep running.
 */

export type RunState = { state: "running" | "stopped"; pausedAt: number | null; resumedAt: number | null };

const DEFAULT: RunState = { state: "stopped", pausedAt: null, resumedAt: null };

export function getRun(): RunState {
  const row = db.prepare("select value from settings where key = 'run'").get() as { value: string } | undefined;
  try {
    return row ? { ...DEFAULT, ...JSON.parse(row.value) } : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

function setRun(patch: Partial<RunState>): RunState {
  const next = { ...getRun(), ...patch };
  db.prepare("insert or replace into settings (key, value, updated_at) values ('run', ?, ?)").run(JSON.stringify(next), Date.now());
  return next;
}

/**
 * Whether buying is paused for the daily loss, moving `pausedAt` as days and the limit pass.
 * auto: a pause from an earlier day lifts at 00:00 UTC. manual: only Resume lifts it. A Resume
 * covers the rest of its day, so the same loss does not pause it again straight away.
 */
export function lossPaused(cfg: Config, now = Date.now()): boolean {
  const r = getRun();
  const midnight = lossDay(now);
  if (r.pausedAt !== null) {
    if (cfg.lossResume === "manual" || r.pausedAt >= midnight) return true;
    setRun({ pausedAt: null });
  }
  if ((r.resumedAt ?? 0) >= midnight || !buyingPaused(cfg, now)) return false;
  setRun({ pausedAt: now });
  log("warn", `Buying paused: today's loss passed ${cfg.maxDailyLossPct}% of the day's start. Exits keep running.`);
  return true;
}

// ── actions ───────────────────────────────────────────────────────────

/** Called once at boot: whatever the last run did, this one waits for Start. */
export function bootStopped(): void {
  if (getRun().state !== "stopped") setRun({ state: "stopped" });
}

export function start(): void {
  if (getRun().state === "running") return;
  setRun({ state: "running" });
  log("info", "Started from the dashboard.");
}

/** Stops every loop. `closeAll` first sells every open position at market. */
export async function stop(closeAll: boolean): Promise<string[]> {
  setRun({ state: "stopped" });
  const errors: string[] = [];
  if (closeAll)
    for (const p of openPositions()) {
      const err = await sell(p.id, 100, "manual");
      if (err) errors.push(`${p.symbol}: ${err}`);
    }
  log("info", `Stopped from the dashboard${closeAll ? ", every position closed" : ""}. No buys and no exits until Start.`, errors.join(" · ") || undefined);
  return errors;
}

export function resume(): void {
  setRun({ pausedAt: null, resumedAt: Date.now() });
  log("info", "Buying resumed by hand.");
}

export async function closePosition(id: number): Promise<string | null> {
  return sell(id, 100, "manual");
}

// ── what the loops are doing, for the dashboard (in memory: it describes this process) ──

export type FeedRow = {
  address: string;
  symbol: string | null;
  source: string;
  mcap: number | null;
  liq: number | null;
  buys: number | null;
  sells: number | null;
  change1h: number | null;
  top10: number | null;
  rug: number | null;
  createdAt: number | null;
};

export const status = {
  startedAt: Date.now(),
  entry: { lastAt: 0, note: "" },
  exit: { lastAt: 0, mints: 0, priceError: "" },
  gmgn: { errorAt: 0, error: "" },
  fetch: { at: 0, rows: [] as FeedRow[] },
};
