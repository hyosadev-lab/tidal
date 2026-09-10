import { store } from "../data/store.ts";

/**
 * Run control, and the one piece of mutable state the cycle shares.
 *
 * Clearing the timers only prevents the *next* cycle. A scan already in flight can be parked
 * on an LLM call for half a minute and would then go on to buy, long after the operator
 * pressed Stop. So a cycle takes a `generation()` at its start and re-checks `aborted(gen)` at
 * every await that precedes a spend. A manual "Scan now" while stopped never sees the number
 * move, so that path still works.
 *
 * Nothing here reaches the rest of the cycle: it is imported by every step, so it must import
 * none of them.
 */

let stopGen = 0;
let monitorTimer: NodeJS.Timeout | null = null;
let scanTimer: NodeJS.Timeout | null = null;
let kickoffTimer: NodeJS.Timeout | null = null;

/** The number a cycle captures at its start. */
export const generation = (): number => stopGen;

/** True once a Stop landed after `gen` was taken — the caller must abandon what it was doing. */
export const aborted = (gen: number): boolean => stopGen !== gen;

/** Invalidate every cycle currently in flight. */
export const cancelInFlight = (): void => void stopGen++;

/**
 * The only place timers are installed, and it clears whatever is already there first.
 * `start()` reaches this after an await in live mode, so two clicks on Start can both get
 * here: without the clear, the second set of handles overwrites the first and that first
 * pair keeps firing forever — an agent the dashboard calls stopped, still scanning and
 * buying, with no handle left to cancel it.
 *
 * The callbacks are passed in rather than imported so this file stays at the bottom of the
 * import graph.
 */
export function arm(
  monitorSeconds: number,
  intervalMinutes: number,
  firstScanMs: number | null,
  onMonitor: () => void,
  onScan: () => void,
): void {
  disarm();
  monitorTimer = setInterval(onMonitor, monitorSeconds * 1000);
  scanTimer = setInterval(onScan, intervalMinutes * 60_000);
  if (firstScanMs !== null) kickoffTimer = setTimeout(onScan, firstScanMs);
}

export function disarm(): void {
  if (monitorTimer) clearInterval(monitorTimer);
  if (scanTimer) clearInterval(scanTimer);
  if (kickoffTimer) clearTimeout(kickoffTimer);
  monitorTimer = scanTimer = kickoffTimer = null;
}

/**
 * Trading stops for the day. Separate from `stop()` so the loss budget can pull the plug from
 * inside a cycle without importing the lifecycle that owns Start and Stop.
 */
export function halt(reason: string): void {
  store.runState = "halted";
  store.haltReason = reason;
  cancelInFlight();
  disarm();
  store.nextRunAt = 0;
  store.log("warn", reason);
  store.push();
}
