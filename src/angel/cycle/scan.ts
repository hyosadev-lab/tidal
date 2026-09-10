import { askAnalyst } from "../analyst.ts";
import { gasReserve } from "../domain/config.ts";
import { gateTally } from "../domain/gates.ts";
import { short } from "../domain/num.ts";
import { store } from "../data/store.ts";
import { recordSoundings } from "../data/soundings.ts";
import * as gmgn from "../market/gmgn.ts";
import { aborted, generation } from "./control.ts";
import { openEntries } from "./entries.ts";
import { applyExits } from "./exits.ts";
import { gatherCandidates } from "./sweep.ts";
import type { Candidate } from "../domain/types.ts";

/**
 * One cycle, in the order it happens: sweep → gate → rank → shortlist → ask the analyst →
 * its exits → its entries. Read `runScan` top to bottom and that is the whole flow; every
 * step it calls lives in a file of its own.
 *
 * The model's exits run *before* the entries on purpose — closing a position frees a slot the
 * entries below may use, and puts that address straight onto cooldown.
 */

/** How many of the eligible rows, best score first, are put in front of the analyst. */
const ANALYST_SHORTLIST = 18;

/** Only one scan runs at a time. */
let scanning = false;

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
  try {
    const [bal, px] = await Promise.all([
      gmgn.nativeBalance(cfg.chain, cfg.walletAddress),
      gmgn.nativeUsdPrice(cfg.chain),
    ]);
    if (bal === null) {
      store.log("warn", "Could not read the wallet balance from the GMGN API — skipping entries this cycle.");
      return false;
    }
    if (!(px > 0)) {
      store.log("warn", "Could not read the native token price — skipping entries this cycle.");
      return false;
    }
    const spendable = Math.max(0, bal - gasReserve(cfg));
    store.cash = spendable * px;
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

/**
 * Why a row that cleared the gates still cannot be bought, or "" when it can. Held / cooldown
 * / blacklist live in the store and never travel on a Candidate — the eligible filter, the
 * dashboard's note and the pre-entry re-check all ask this, so they cannot drift apart.
 */
function unavailable(c: Candidate): string {
  if (store.position(c.address)) return "already held";
  if (store.onCooldown(c.address)) return "on cooldown after a recent exit";
  if (store.isBlacklisted(c.address)) return "blacklisted";
  return "";
}

export async function runScan(): Promise<void> {
  if (scanning) return;
  scanning = true;
  const gen = generation();
  store.busy = true;
  const cfg = store.config;

  try {
    store.rollDay();
    const balanceOk = await syncLiveBalance();
    const cycle = store.bumpCycle();
    store.lastRunAt = Date.now();
    store.phase = "scanning";
    store.push();

    const candidates = await gatherCandidates();
    const eligible = candidates.filter((c) => !c.gateFailures.length && !store.unavailable(c.address));
    // Why each row did or did not reach the model, decided here rather than in the dashboard.
    // Written before the soundings so calibrate can tell the rows the model actually saw from
    // the ones that merely scored well.
    const shortlist = eligible.slice(0, ANALYST_SHORTLIST);
    const shown = new Set(shortlist.map((c) => c.address));
    for (const c of candidates)
      c.analystNote = c.gateFailures.length
        ? ""
        : shown.has(c.address)
          ? "sent"
          : store.unavailable(c.address) || `ranked below the top ${ANALYST_SHORTLIST}`;
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

    const decision = await askAnalyst(shortlist, cfg.maxOpenPositions - store.positions.length);
    if (!decision) return;
    if (aborted(gen)) {
      store.log("info", "Cycle abandoned — stopped while the analyst was thinking.");
      return;
    }
    if (decision.notes) store.log("model", decision.notes);

    // Model-requested exits first — freeing a slot may enable an entry below.
    await applyExits(decision.exits ?? []);

    const slots = cfg.maxOpenPositions - store.positions.length;
    if (slots <= 0) {
      if (decision.entries?.length) store.log("info", "Entries skipped — position limit reached.");
      return;
    }

    if (!balanceOk) {
      store.log("warn", "No entries this cycle — the wallet balance is unknown, so sizing cannot be trusted.");
      return;
    }

    store.phase = "entering";
    const opened = await openEntries(decision.entries ?? [], eligible, cfg, slots, gen);
    if (!opened && decision.entries?.length === 0) store.log("info", "No entry this cycle.");
  } catch (e) {
    store.log("error", `Scan failed: ${short(e)}`);
  } finally {
    scanning = false;
    store.busy = false;
    store.phase = "idle";
    store.nextRunAt = Date.now() + store.config.intervalMinutes * 60_000;
    store.markEquity();
    store.push();
  }
}
