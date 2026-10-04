import { askAnalyst } from "../analyst.ts";
import { gasReserve } from "../domain/config.ts";
import { gateTally } from "../domain/gates.ts";
import { short } from "../domain/num.ts";
import { observe, pruneWatchlist, reviseWatchlist } from "../domain/watchlist.ts";
import { store } from "../data/store.ts";
import { recordSoundings } from "../data/soundings.ts";
import * as gmgn from "../market/gmgn.ts";
import * as jupiter from "../market/jupiter.ts";
import { aborted, claim, generation, release } from "./control.ts";
import { applyExits } from "./exits.ts";
import { gatherCandidates } from "./sweep.ts";

/**
 * The sweep stage, in the order it happens: sweep → gate → rank → ask the analyst → its exits →
 * its watchlist edits. Read `runScan` top to bottom and that is the whole stage; every step it
 * calls lives in a file of its own.
 *
 * **Nothing is bought here.** The analyst picks what goes on the watchlist; `watch.ts` is the
 * second stage, and the only one that opens a position.
 *
 * There is no shortlist: every eligible row goes in the brief, so a cycle's prompt grows with
 * the sweep (three feeds of 40, deduped) and the ranking only decides reading order.
 */

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
  if (!claim()) return;
  const gen = generation();
  store.busy = true;
  const cfg = store.config;

  try {
    store.rollDay();
    // Nothing is sized here, but the brief quotes cash and the round trip off it.
    await syncLiveBalance();
    const cycle = store.bumpCycle();
    store.lastRunAt = Date.now();
    store.phase = "scanning";
    store.push();

    const candidates = await gatherCandidates();
    // A watched token the sweep carries again gets this sweep's row — fresher than the one it
    // was added with, and free. One that now fails a gate is pruned right below.
    const now = Date.now();
    for (const w of store.watchlist) {
      const fresh = candidates.find((c) => c.address.toLowerCase() === w.c.address.toLowerCase());
      if (!fresh) continue;
      w.c = fresh;
      observe(w, fresh.priceUsd, now);
    }
    store.setWatchlist(pruneWatchlist(store.watchlist, now, cfg.chain, (a) => store.unavailable(a)));

    // Watched rows are left out of the candidates: the analyst sees them in `watchlist`, and
    // listing them twice only invites it to add what is already there.
    const eligible = candidates.filter((c) => !c.gateFailures.length && !store.unavailable(c.address) && !store.watching(c.address));
    // Why each row did or did not reach the model, decided here rather than in the dashboard.
    // Every eligible row is sent now, so the only reason a gated-through row is missing is that
    // it is held, on cooldown, blacklisted or already watched.
    for (const c of candidates)
      c.analystNote = c.gateFailures.length
        ? ""
        : store.unavailable(c.address) || (store.watching(c.address) ? "on the watchlist" : "sent");
    store.lastCandidates = candidates.slice(0, 40);
    // The whole sweep, not just the shown 40: `calibrate.ts` needs the rows nobody looked at
    // as much as the ones that scored well, or it only measures what we already believed.
    recordSoundings(cycle, cfg.chain, candidates);
    store.log(
      "info",
      `Cycle ${cycle}: ${candidates.length} tokens scanned, ${eligible.length} through the gates.`,
      eligible.length ? eligible.slice(0, 8).map((c) => `${c.symbol} ${c.score}`).join("  ") : undefined,
    );
    // Which gate did the killing. The thresholds are fixed now, so the only thing left worth
    // measuring is which of them actually fires — a gate that never fires is dead weight, and
    // one that rejects most of the sweep is quietly the whole strategy. Counts exceed the
    // number of rejects: a token can fail several gates at once.
    const tally = gateTally(candidates);
    if (tally) store.log("info", `Gates: ${tally}`);

    if (!eligible.length && !store.positions.length) {
      store.phase = "idle";
      return;
    }

    store.phase = "analysing";
    store.push();

    const decision = await askAnalyst("sweep", eligible, cfg.maxOpenPositions - store.positions.length);
    if (!decision) return;
    if (aborted(gen)) {
      store.log("info", "Cycle abandoned — stopped while the analyst was thinking.");
      return;
    }
    if (decision.notes) store.log("model", decision.notes);

    // Exits first: a position the model closes goes onto cooldown, and must not be watched.
    await applyExits(decision.exits);
    store.setWatchlist(reviseWatchlist(store.watchlist, decision.watch, decision.unwatch, eligible, cfg.chain, Date.now()));
    if (!decision.watch.length) store.log("info", "Nothing added to the watchlist this cycle.");
  } catch (e) {
    store.log("error", `Scan failed: ${short(e)}`);
  } finally {
    release();
    store.busy = false;
    store.phase = "idle";
    store.nextRunAt = Date.now() + store.config.intervalMinutes * 60_000;
    store.markEquity();
    store.push();
  }
}
