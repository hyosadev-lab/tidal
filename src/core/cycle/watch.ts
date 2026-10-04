import { askAnalyst } from "../analyst.ts";
import { num, short } from "../domain/num.ts";
import { observe, pruneWatchlist, reviseWatchlist } from "../domain/watchlist.ts";
import { store } from "../data/store.ts";
import * as gmgn from "../market/gmgn.ts";
import { aborted, claim, generation, release } from "./control.ts";
import { openEntries } from "./entries.ts";
import { applyExits } from "./exits.ts";
import { syncLiveBalance } from "./scan.ts";

/**
 * The watch tick: the second stage of the flow, for the tokens the sweep chose to wait on.
 *
 * The sweep (`scan.ts`) buys what it is sure of and puts the rest of its picks on the watchlist;
 * every `WATCH_MINUTES` this re-prices them, shows the analyst each one with its price trail and
 * the note it left itself, and lets it buy, keep watching or drop. What the model sees is
 * therefore a token over time rather than one snapshot — which is the whole point of the list.
 *
 * It runs off its own timer only, never straight behind a sweep: a tick seconds after the sweep
 * that filled the list re-judges the same snapshot and drops what was just added. The tick the
 * timer fires *during* a sweep is dropped by the shared lock, so every third one is skipped.
 *
 * Everything a buy went through before still applies: `openEntries` re-checks cooldown,
 * blacklist and held, and `securityRisk` runs per entry.
 */
export async function runWatch(): Promise<void> {
  if (!store.watchlist.length || !claim()) return;
  const gen = generation();
  store.busy = true;
  const cfg = store.config;

  try {
    store.setWatchlist(pruneWatchlist(store.watchlist, Date.now(), cfg.chain, (a) => store.unavailable(a)));
    if (!store.watchlist.length) return;

    store.phase = "watching";
    store.push();

    for (const w of store.watchlist) {
      try {
        const info = await gmgn.tokenInfo(cfg.chain, w.c.address);
        observe(w, num(info?.price?.price), Date.now());
        // Paper slippage and the position's entry liquidity are both read off the row.
        if (num(info?.liquidity) > 0) w.c.liquidityUsd = num(info.liquidity);
      } catch (e) {
        store.log("warn", `Watchlist price refresh failed for ${w.c.symbol}: ${short(e)}`);
      }
    }

    const balanceOk = await syncLiveBalance();
    const seen = store.watchlist.map((w) => w.c);
    const decision = await askAnalyst("watch", seen, cfg.maxOpenPositions - store.positions.length);
    if (!decision) return;
    if (aborted(gen)) {
      store.log("info", "Watch tick abandoned — stopped while the analyst was thinking.");
      return;
    }
    if (decision.notes) store.log("model", decision.notes);

    // Model-requested exits first — freeing a slot may enable an entry below.
    await applyExits(decision.exits);
    store.setWatchlist(reviseWatchlist(store.watchlist, [], decision.unwatch, [], cfg.chain, Date.now()));

    const slots = cfg.maxOpenPositions - store.positions.length;
    if (slots <= 0) {
      if (decision.entries.length) store.log("info", "Entries skipped — position limit reached.");
      return;
    }
    if (!balanceOk) {
      store.log("warn", "No entries this tick — the wallet balance is unknown, so sizing cannot be trusted.");
      return;
    }

    store.phase = "entering";
    await openEntries(decision.entries, seen, cfg, slots, gen, "watchlist");
    // Bought is no longer watched.
    store.setWatchlist({ list: store.watchlist.filter((w) => !store.position(w.c.address)), notes: [] });
  } catch (e) {
    store.log("error", `Watch tick failed: ${short(e)}`);
  } finally {
    release();
    store.busy = false;
    store.phase = "idle";
    store.markEquity();
    store.push();
  }
}
