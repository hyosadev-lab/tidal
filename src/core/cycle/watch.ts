import { askAnalyst } from "../analyst.ts";
import { num, short } from "../domain/num.ts";
import { observe, pruneWatchlist, reviseWatchlist, ripe } from "../domain/watchlist.ts";
import { store } from "../data/store.ts";
import * as gmgn from "../market/gmgn.ts";
import { aborted, claim, generation, release } from "./control.ts";
import { openEntries } from "./entries.ts";
import { applyExits } from "./exits.ts";
import { syncLiveBalance } from "./scan.ts";

/**
 * The watch tick: the second stage of the flow, for the tokens the sweep chose to wait on.
 *
 * The sweep (`scan.ts`) buys what it is sure of and puts the rest of its picks on the watchlist; every `WATCH_MINUTES` this re-prices them,
 * shows the analyst each one with its price trail and the note it left itself, and lets it buy,
 * keep watching or drop. What the model sees is therefore a token over time rather than one
 * snapshot — which is the whole point of the list.
 *
 * Everything a buy went through before still applies: `openEntries` re-checks cooldown,
 * blacklist and held, `securityRisk` runs per entry, and only a token watched long enough
 * (`ripe`) is offered to it at all.
 */
export async function runWatch(): Promise<void> {
  if (!store.watchlist.length || !claim()) return;
  const gen = generation();
  store.busy = true;
  const cfg = store.config;

  try {
    store.setWatchlist(pruneWatchlist(store.watchlist, Date.now(), cfg.chain, (a) => store.unavailable(a)));
    // Nothing watched long enough yet: there is nothing new to show the analyst and nothing it
    // could buy. This is the tick right behind the sweep that filled an empty list — without the
    // check the model re-judges the same snapshot seconds later and drops what it just added.
    if (!store.watchlist.some((w) => ripe(w, Date.now()))) return;

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
    // Only what has been watched long enough is shown, so a token added a moment ago can be
    // neither bought nor dropped before there is anything to judge it on.
    const seen = store.watchlist.filter((w) => ripe(w, Date.now())).map((w) => w.c);
    const decision = await askAnalyst("watch", seen, cfg.maxOpenPositions - store.positions.length);
    if (!decision) return;
    if (aborted(gen)) {
      store.log("info", "Watch tick abandoned — stopped while the analyst was thinking.");
      return;
    }
    if (decision.notes) store.log("model", decision.notes);

    // Model-requested exits first — freeing a slot may enable an entry below.
    await applyExits(decision.exits);
    const shown = (u: { address: string }) => seen.some((c) => c.address.toLowerCase() === String(u?.address ?? "").toLowerCase());
    store.setWatchlist(reviseWatchlist(store.watchlist, [], decision.unwatch.filter(shown), [], cfg.chain, Date.now()));

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
