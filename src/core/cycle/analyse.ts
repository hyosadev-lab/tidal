import { askAnalyst } from "../analyst.ts";
import { dueNow } from "../domain/candidates.ts";
import { clamp, short } from "../domain/num.ts";
import { store } from "../data/store.ts";
import { aborted, claim, generation, release } from "./control.ts";
import { openEntries } from "./entries.ts";
import { applyExits } from "./exits.ts";
import { syncLiveBalance } from "./scan.ts";

/**
 * The analyst's queue: every token that is due, in one LLM call. Every fetch kicks it, so a
 * token the feeds have just surfaced is analysed straight after the fetch that carried it. A
 * kick that lands while a call is out is a no-op; the loop looks at the fresher pool once that
 * call is back, so nothing waits for the next fetch.
 *
 * The analyst says when it wants each token back (`recheck`, clamped 1–30 here, not in the
 * prompt). The whole batch is first marked with `RECHECK_DEFAULT_MINUTES` before the call, so a
 * token it left out still has a time and a broken call cannot spin on the same rows.
 *
 * It does not run with every slot taken: nothing could be bought, and each call is paid for.
 * The cost is that the analyst's early exits are only asked for while a slot is free — the
 * exit plan, the health exit and the time stop never needed the model.
 */

/** When a token comes back if the analyst did not say, or its call failed. */
const RECHECK_DEFAULT_MINUTES = 15;

export async function runAnalyst(): Promise<void> {
  if (!claim()) return;
  const gen = generation();
  try {
    while (!aborted(gen) && store.runState !== "halted") {
      const cfg = store.config;
      const slots = cfg.maxOpenPositions - store.positions.length;
      if (slots <= 0) break;
      const batch = dueNow(store.pool, store.analysed, Date.now(), (a) => store.unavailable(a));
      if (!batch.length) break;

      store.busy = true;
      store.phase = "analysing";
      const fresh = new Set(batch.filter((c) => !store.analysed.has(c.address.toLowerCase())).map((c) => c.address));
      for (const c of batch) {
        store.analysed.set(c.address.toLowerCase(), Date.now() + RECHECK_DEFAULT_MINUTES * 60_000);
        c.analystNote = "sent";
      }
      store.push();

      const decision = await askAnalyst(batch, slots, fresh);
      // A dead key or a model down fails the same way straight away: stop, the next fetch retries.
      if (!decision) break;
      if (aborted(gen)) {
        store.log("info", "Analysis abandoned — stopped while the analyst was thinking.");
        break;
      }
      // Only for tokens it was shown: a time for an address outside the batch would park a token it never judged.
      const shown = new Map(batch.map((c) => [c.address.toLowerCase(), c.symbol]));
      const again: string[] = [];
      for (const r of decision.recheck) {
        const key = String(r?.address ?? "").toLowerCase();
        if (!shown.has(key)) continue;
        const minutes = clamp(r.minutes, 1, 30, RECHECK_DEFAULT_MINUTES);
        store.analysed.set(key, Date.now() + minutes * 60_000);
        // The clamp is silent to the model, so the log says when it bit: an analyst that keeps asking
        // for 60 reads as one that always picks 30 otherwise.
        const asked = Number(r.minutes);
        again.push(`${shown.get(key)} ${minutes}m${Number.isFinite(asked) && asked !== minutes ? ` (asked ${asked})` : ""}`);
      }
      store.log(
        "model",
        `Analysed ${batch.length} (${fresh.size} new): ${decision.notes || "no note"}`,
        // "the rest" only when there is one: on a batch it answered in full the phrase reads as a second rule.
        [again.length ? `next look: ${again.join("  ")}` : "", again.length < batch.length ? `${again.length ? "the rest" : "all"} in ${RECHECK_DEFAULT_MINUTES}m` : ""]
          .filter(Boolean)
          .join(" · "),
      );

      // Exits first: closing a position frees a slot and puts its address onto cooldown.
      await applyExits(decision.exits);
      if (!decision.entries.length) continue;
      if (!(await syncLiveBalance())) continue;
      store.phase = "entering";
      await openEntries(decision.entries, batch, cfg, cfg.maxOpenPositions - store.positions.length, gen);
      store.markEquity();
    }
  } catch (e) {
    store.log("error", `Analysis failed: ${short(e)}`);
  } finally {
    release();
    store.busy = false;
    store.phase = "idle";
    store.push();
  }
}
