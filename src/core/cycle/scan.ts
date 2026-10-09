import { gasReserve } from "../domain/config.ts";
import { gateTally } from "../domain/gates.ts";
import { short } from "../domain/num.ts";
import { store } from "../data/store.ts";
import { recordSoundings } from "../data/soundings.ts";
import * as gmgn from "../market/gmgn.ts";
import * as jupiter from "../market/jupiter.ts";
import { gatherCandidates } from "./sweep.ts";

/**
 * The fetch: every `FETCH_SECONDS` the three feeds are read, gated, scored and left in
 * `store.pool`. That is all it does — no model, no lock, no buying. The analyst (`analyse.ts`)
 * takes whatever in that pool is due, in one call.
 */

/** Seconds between fetches. The sweep is 8 bucket weight, so this is 8 of the ~40 a minute refills. */
export const FETCH_SECONDS = 60;

/**
 * Minutes between soundings. Every fetch used to be recorded, at one fetch per 15 minutes;
 * at one a minute that is ~150k JSON rows a day for `calibrate.ts`, which only needs a sample.
 */
const SOUNDING_MINUTES = 15;
let soundedAt = 0;
let fetching = false;

/** The last successful `syncLiveBalance`, and the wallet it was for. */
let synced = { key: "", at: 0 };

/**
 * In live mode the ledger must reflect the actual wallet, not the paper bankroll.
 * Without this, sizing is computed against an invented balance and GMGN rejects the
 * swap with `insufficient token balance` — an error that has its own rate limiter,
 * so repeatedly guessing wrong gets the key throttled.
 *
 * Returns false when the balance could not be read; callers must then skip entries
 * rather than fall back to a number they made up.
 */
export async function syncLiveBalance(): Promise<boolean> {
  const cfg = store.config;
  if (cfg.mode !== "live") return true;
  // Start reads the wallet, and the first scan fires 1.5s later and read it again: two RPC
  // calls and two identical log lines. A read this fresh for the same wallet is still the answer.
  const key = `${cfg.chain}:${cfg.walletAddress}`;
  if (synced.key === key && Date.now() - synced.at < 10_000) return true;
  try {
    const [bal, px] = await Promise.all([
      // Solana trades from the operator's own key, which need not be a wallet GMGN knows.
      cfg.chain === "sol" ? jupiter.solBalance(cfg.walletAddress) : gmgn.nativeBalance(cfg.chain, cfg.walletAddress),
      gmgn.nativeUsdPrice(cfg.chain),
    ]);
    if (bal === null) {
      store.log("warn", "Could not read the wallet balance — skipping entries this cycle.");
      return false;
    }
    if (!(px > 0)) {
      store.log("warn", "Could not read the native token price — skipping entries this cycle.");
      return false;
    }
    const spendable = Math.max(0, bal - gasReserve(cfg));
    store.cash = spendable * px;
    synced = { key, at: Date.now() };
    store.log(
      "info",
      `Wallet: ${bal.toFixed(4)} ${gmgn.NATIVE_SYMBOL[cfg.chain]} · $${store.cash.toFixed(2)} spendable (${gasReserve(cfg)} held back for gas).`,
    );
    return true;
  } catch (e) {
    store.log("warn", `Wallet balance check failed: ${short(e)} — skipping entries this cycle.`);
    return false;
  }
}

export async function runScan(): Promise<void> {
  // A fetch held up by the rate limiter can outlast the minute; the next one is skipped, not stacked.
  if (fetching) return;
  fetching = true;
  const cfg = store.config;
  try {
    store.rollDay();
    const cycle = store.bumpCycle();
    const now = Date.now();
    const candidates = await gatherCandidates();

    // Why each row will or will not reach the model, decided here rather than in the dashboard.
    for (const c of candidates)
      c.analystNote = c.gateFailures.length
        ? ""
        : store.unavailable(c.address) || (now < (store.analysed.get(c.address.toLowerCase()) ?? 0) ? "sent" : "queued");
    store.pool = candidates;
    store.lastCandidates = candidates.slice(0, 40);

    // The whole sweep, not just the shown 40: `calibrate.ts` needs the rows nobody looked at
    // as much as the ones that scored well, or it only measures what we already believed.
    if (now - soundedAt >= SOUNDING_MINUTES * 60_000) {
      recordSoundings(cycle, cfg.chain, candidates);
      soundedAt = now;
    }

    // One line a fetch, and only when there is something for the analyst: at one fetch a
    // minute anything more is the whole log.
    const queued = candidates.filter((c) => c.analystNote === "queued");
    if (queued.length)
      store.log(
        "info",
        `Fetch ${cycle}: ${candidates.length} tokens, ${queued.length} queued for the analyst.`,
        [queued.slice(0, 8).map((c) => `${c.symbol} ${c.score}`).join("  "), gateTally(candidates)].filter(Boolean).join(" · gates: "),
      );
  } catch (e) {
    store.log("error", `Fetch failed: ${short(e)}`);
  } finally {
    fetching = false;
    store.push();
  }
}
