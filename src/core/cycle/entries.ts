import { buyableSet } from "../domain/candidates.ts";
import { liveReady, minPosition, tradeSize } from "../domain/config.ts";
import { securityRisk } from "../domain/gates.ts";
import { clamp, short } from "../domain/num.ts";
import { entryStop, entryStrategy, positionSize } from "../domain/positions.ts";
import { store } from "../data/store.ts";
import * as broker from "../market/broker.ts";
import * as gmgn from "../market/gmgn.ts";
import { aborted } from "./control.ts";
import type { Candidate, Decision, StrategyRule, TradeConfig } from "../domain/types.ts";

/**
 * The only place in this process that opens a position.
 *
 * `gen` is threaded through from the cycle that started it: a Stop between the analyst's
 * answer and the swap must not still buy, and the security lookup below is another network
 * round trip's worth of window for one to land.
 */

/** The model's picks, sized and bought. Returns how many positions were opened. */
export async function openEntries(
  entries: Decision["entries"],
  eligible: Candidate[],
  cfg: TradeConfig,
  slots: number,
  gen: number,
): Promise<number> {
  // The daily loss halt is enforced here, the one place that buys: a manual scan still runs
  // while halted, and its exits are welcome — its entries are not.
  if (store.runState === "halted") {
    if (entries.length) store.log("info", "Entries skipped — trading is halted by the daily loss limit.");
    return 0;
  }
  // Re-checked here, not reused from the scan: the model's exits ran in between, and
  // closing a position puts its address straight onto cooldown.
  const blocked = new Set(eligible.filter((c) => store.unavailable(c.address)).map((c) => c.address.toLowerCase()));
  const byAddress = buyableSet(eligible, blocked);
  let opened = 0;

  // Size is a fixed amount of the native token, so entries need its USD price. Cached for 30s
  // and asked for by every buy anyway; without it there is nothing to size against.
  const nativeUsd = await gmgn.nativeUsdPrice(cfg.chain).catch(() => 0);
  if (!(nativeUsd > 0)) {
    store.log("warn", `Could not read the ${cfg.chain.toUpperCase()} price — entries skipped this cycle rather than sized off a guess.`);
    return 0;
  }

  for (const e of entries) {
    if (opened >= slots) break;
    const c = byAddress.get(String(e.address ?? "").toLowerCase());
    if (!c) {
      store.log(
        "warn",
        // The address is what the lookup actually used, so log it: a mistyped or omitted
        // one looks identical to a gate failure without it.
        `Analyst picked ${String(e.symbol ?? "?").slice(0, 20)} (${String(e.address ?? "no address").slice(0, 24)}), which is not eligible — it failed a gate, is on cooldown, or was never scanned. Skipped.`,
      );
      continue;
    }
    if (store.position(c.address)) continue;

    const conviction = clamp(e.conviction, 0, 100, c.score);
    if (conviction < 40) {
      store.log("info", `${c.symbol} skipped — conviction ${conviction} below the 40 floor.`);
      continue;
    }

    const size = positionSize(cfg, store.cash, nativeUsd);
    const floor = minPosition(cfg);
    if (size < floor) {
      store.log(
        "warn",
        `${c.symbol} skipped — position would be $${size.toFixed(2)}, under the $${floor} floor (${tradeSize(cfg)} ${gmgn.NATIVE_SYMBOL[cfg.chain]}; cash $${store.cash.toFixed(2)}).`,
      );
      continue;
    }

    await openPosition(
      gen,
      c,
      size,
      String(e.thesis ?? "").slice(0, 400),
      conviction,
      entryStop(cfg, e.stopLossPct),
      entryStrategy(cfg, e.strategy),
    );
    opened++;
  }
  return opened;
}

// ── execution ─────────────────────────────────────────────────────────

async function openPosition(
  gen: number,
  c: Candidate,
  usd: number,
  thesis: string,
  conviction: number,
  stopLossPct: number,
  strategy: StrategyRule[],
): Promise<void> {
  const cfg = store.config;
  if (cfg.mode === "live") {
    const ready = liveReady(cfg);
    if (!ready.ok) {
      store.log("error", `Live entry blocked — ${ready.reason}.`);
      return;
    }
  }

  // Checked here rather than in runGates because only token_security answers these reliably,
  // and one call per actual entry is affordable where one per scanned token is not. Runs on
  // every chain — the tax half applies everywhere, the Solana half no-ops elsewhere — and in
  // paper mode too, so paper results stay comparable to live ones. Fails closed.
  let sec: Record<string, any> | null = null;
  try {
    sec = await gmgn.tokenSecurity(cfg.chain, c.address);
  } catch (e) {
    store.log("warn", `${c.symbol} skipped — security check failed: ${short(e)}`);
    return;
  }
  const risk = securityRisk(sec, cfg.chain);
  if (risk) {
    store.log("warn", `${c.symbol} skipped — ${risk}.`);
    return;
  }

  // Last checkpoint before the swap: the security call above is another network round trip,
  // and this is the only place in the process that opens a position.
  if (aborted(gen)) {
    store.log("info", `${c.symbol} not bought — stopped mid-cycle.`);
    return;
  }

  try {
    const res = await broker.buy(store, cfg, c, usd, thesis, conviction, stopLossPct, strategy);
    if ("error" in res) {
      store.log("warn", `Buy ${c.symbol} failed: ${res.error}`);
      if (/honeypot/i.test(res.error)) store.blacklist(c.address);
      return;
    }
    store.addPosition(res.position);
    store.addTrade(res.trade);
    store.log(
      "trade",
      `BUY ${c.symbol} — $${res.trade.usd.toFixed(2)} at $${res.trade.price.toPrecision(4)} (conviction ${conviction})`,
      thesis,
    );
  } catch (e) {
    store.log("error", `Buy ${c.symbol} errored: ${short(e)}`);
  }
}
