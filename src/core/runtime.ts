import { minPosition, liveReady, tradeSize } from "./domain/config.ts";
import { clamp } from "./domain/num.ts";
import { store } from "./data/store.ts";
import * as gmgn from "./market/gmgn.ts";
import * as jupiter from "./market/jupiter.ts";
import { arm, cancelInFlight, disarm, onResume } from "./cycle/control.ts";
import { closePosition } from "./cycle/exits.ts";
import { runMonitor, stopStreams } from "./cycle/monitor.ts";
import { runAnalyst } from "./cycle/analyse.ts";
import { FETCH_SECONDS, runScan, syncLiveBalance } from "./cycle/scan.ts";

/**
 * The lifecycle, and the whole surface `src/index.ts` drives. Everything below assembles the
 * cycle; nothing in `cycle/` imports this file back.
 */

export { syncLiveBalance };

/** One fetch, then the analyst on whatever it left queued. Two loops, joined only by this kick. */
const fetchThenAnalyse = (): void => void runScan().then(runAnalyst);

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
    `Started on ${cfg.chain.toUpperCase()} in ${cfg.mode} mode — fetching tokens every ${FETCH_SECONDS}s, analysing whatever is due after each fetch, checking exits every ${cfg.monitorSeconds}s.`,
  );

  arm(cfg.monitorSeconds, FETCH_SECONDS, 1500, () => void runMonitor(), fetchThenAnalyse);
  store.push();
  return { ok: true };
}

export function stop(keepState = false): void {
  cancelInFlight();
  disarm();
  stopStreams();
  if (!keepState && store.runState === "running") {
    store.runState = "stopped";
    store.log("info", "Stopped. Open positions are left untouched — close them from the dashboard if you want out.");
  }
  store.push();
}

let walletCache: { at: number; list: gmgn.BoundWallet[] } | null = null;

/**
 * The wallets the dashboard's picker offers, with their balances. Cached because every page load
 * asks and the read is paid out of the sweep's rate limit; `fresh` is the picker's refresh
 * button. A failed read is not cached.
 */
export async function wallets(fresh = false): Promise<{ at: number; list: gmgn.BoundWallet[] }> {
  if (fresh || !walletCache || Date.now() - walletCache.at > 5 * 60_000) {
    const list = await gmgn.boundWallets();
    // The wallet `SOLANA_PRIVATE_KEY` signs for is the one live Solana trades from, whether or
    // not GMGN has it bound — so the picker has to offer it.
    const mine = jupiter.address();
    if (mine && !list.some((w) => w.chain === "sol" && w.address === mine))
      list.unshift({ chain: "sol", address: mine, native: await jupiter.solBalance(mine).catch(() => null), tokens: [] });
    walletCache = { at: Date.now(), list };
  }
  return walletCache;
}

export async function scanNow(): Promise<void> {
  await runScan();
  await runAnalyst();
}

export async function manualClose(positionId: string, percent = 100): Promise<{ ok: boolean; error?: string }> {
  const p = store.positions.find((x) => x.id === positionId);
  if (!p) return { ok: false, error: "position not found" };
  await closePosition(p, clamp(percent, 1, 100, 100), "closed by hand from the dashboard");
  return { ok: true };
}
