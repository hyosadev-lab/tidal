import { minPosition, liveReady, tradeSize } from "./domain/config.ts";
import { clamp } from "./domain/num.ts";
import { store } from "./data/store.ts";
import * as gmgn from "./market/gmgn.ts";
import { arm, cancelInFlight, disarm, onResume } from "./cycle/control.ts";
import { closePosition } from "./cycle/exits.ts";
import { runMonitor } from "./cycle/monitor.ts";
import { runScan, syncLiveBalance } from "./cycle/scan.ts";

/**
 * The lifecycle, and the whole surface `src/index.ts` drives. Everything below assembles the
 * cycle; nothing in `cycle/` imports this file back.
 */

export { syncLiveBalance };

// A loss halt resumes through the same checks as Start. If they refuse, it stays halted and says why.
onResume(() => {
  if (store.runState !== "halted") return;
  void start().then((r) => {
    if (r.ok) return;
    store.haltReason = `Could not resume automatically: ${r.error}`;
    store.log("warn", store.haltReason);
    store.push();
  });
});

export async function start(): Promise<{ ok: boolean; error?: string }> {
  if (store.runState === "running") return { ok: true };
  const cfg = store.config;

  if (cfg.mode === "live") {
    const ready = liveReady(cfg);
    if (!ready.ok) return { ok: false, error: `Live mode needs setup: ${ready.reason}.` };
    // Size against the real wallet before deciding whether the settings can work at all.
    if (!(await syncLiveBalance()))
      return { ok: false, error: "Could not read your wallet balance from the GMGN API. Check GMGN_API_KEY and your wallet address." };
  }
  if (!process.env.OPENROUTER_API_KEY) return { ok: false, error: "OPENROUTER_API_KEY is missing from .env." };

  // A fixed size that lands under the chain's floor skips every candidate forever — say so
  // now, not next cycle. A price we cannot read just leaves the check unrun.
  const sym = gmgn.NATIVE_SYMBOL[cfg.chain];
  const size = tradeSize(cfg);
  if (!(size > 0))
    return { ok: false, error: `Set a size per trade for ${cfg.chain.toUpperCase()} first — it is blank, so there is nothing to buy with.` };
  const nativeUsd = await gmgn.nativeUsdPrice(cfg.chain).catch(() => 0);
  const floor = minPosition(cfg);
  if (nativeUsd > 0 && size * nativeUsd < floor) {
    return {
      ok: false,
      error:
        `${size} ${sym} is $${(size * nativeUsd).toFixed(2)} — under the $${floor} minimum for ${cfg.chain.toUpperCase()}. ` +
        `Raise size per trade to at least ${(floor / nativeUsd).toPrecision(2)} ${sym}.`,
    };
  }

  store.rollDay();
  store.runState = "running";
  store.haltReason = "";
  store.log(
    "info",
    `Started on ${cfg.chain.toUpperCase()} in ${cfg.mode} mode — scanning every ${cfg.intervalMinutes}m, checking exits every ${cfg.monitorSeconds}s.`,
  );

  arm(cfg.monitorSeconds, cfg.intervalMinutes, 1500, () => void runMonitor(), () => void runScan());
  store.nextRunAt = Date.now() + 1500;
  store.push();
  return { ok: true };
}

export function stop(keepState = false): void {
  cancelInFlight();
  disarm();
  if (!keepState && store.runState === "running") {
    store.runState = "stopped";
    store.log("info", "Stopped. Open positions are left untouched — close them from the dashboard if you want out.");
  }
  store.nextRunAt = 0;
  store.push();
}

/** Restart the timers so a changed interval takes effect immediately. */
export function reschedule(): void {
  if (store.runState !== "running") return;
  arm(store.config.monitorSeconds, store.config.intervalMinutes, null, () => void runMonitor(), () => void runScan());
  store.nextRunAt = Date.now() + store.config.intervalMinutes * 60_000;
  store.push();
}

export async function scanNow(): Promise<void> {
  await runScan();
}

export async function manualClose(positionId: string, percent = 100): Promise<{ ok: boolean; error?: string }> {
  const p = store.positions.find((x) => x.id === positionId);
  if (!p) return { ok: false, error: "position not found" };
  await closePosition(p, clamp(percent, 1, 100, 100), "closed by hand from the dashboard");
  return { ok: true };
}
