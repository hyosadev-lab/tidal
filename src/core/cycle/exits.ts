import { isDust } from "../domain/positions.ts";
import { clamp, short } from "../domain/num.ts";
import { store } from "../data/store.ts";
import * as broker from "../market/broker.ts";
import * as gmgn from "../market/gmgn.ts";
import { halt } from "./control.ts";
import type { Decision, Position, Trade, TradeConfig } from "../domain/types.ts";

/**
 * Every way a position gets smaller, and the single bookkeeping path they all end in.
 * `bookSell` is that path: this process selling, GMGN's own attached plan selling, the
 * operator selling by hand — all three land there, so the ledger cannot drift by route.
 */

export async function applyExits(exits: Decision["exits"]): Promise<void> {
  for (const x of exits) {
    const p = store.position(String(x.address ?? ""));
    if (!p) continue;
    await closePosition(p, clamp(x.percent, 1, 100, 100), `analyst: ${String(x.reason ?? "thesis changed").slice(0, 140)}`);
  }
}


export async function closePosition(p: Position, percentOfOriginal: number, reason: string): Promise<void> {
  const cfg = store.config;
  try {
    // Parked under Jupiter orders, the tokens are not in the wallet to be sold. Whatever this
    // sale leaves behind comes back with them and is the monitor's to run from here on.
    if (cfg.mode === "live" && p.jupiterExits && !(await broker.withdrawExits(store, p))) {
      store.log("error", `Sell ${p.symbol} held back: its Jupiter orders are still in place. The monitor retries its own exits next tick; repeat a manual close.`);
      return;
    }
    const res = await broker.sell(store, cfg, p, percentOfOriginal, reason, p.entryLiquidityUsd);
    if ("error" in res) {
      store.log("error", `Sell ${p.symbol} failed: ${res.error}`);
      return;
    }
    const pnl = res.trade.pnlUsd ?? 0;
    store.log(
      "trade",
      `SELL ${p.symbol} ${percentOfOriginal}% — $${res.proceeds.toFixed(2)} · ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} (${(res.trade.pnlPct ?? 0).toFixed(1)}%)`,
      reason,
    );
    await bookSell(p, cfg, res.qtySold, res.proceeds, res.trade);
  } catch (e) {
    store.log("error", `Sell ${p.symbol} errored: ${short(e)}`);
  }
}

/**
 * Everything that happens *after* a sell exists, whoever made it: this process through
 * `broker.sell`, or GMGN's own side booked by `reconcile`. Both paths shrink the position,
 * record the trade, and close it out when nothing tradeable is left — and both owe the daily
 * loss budget a look, which matters most on the reconcile path, because in live mode GMGN's
 * fills are where the losses actually land.
 */
export async function bookSell(p: Position, cfg: TradeConfig, qtySold: number, proceeds: number, trade: Trade): Promise<void> {
  p.qty = Math.max(0, p.qty - qtySold);
  p.realisedUsd += proceeds;
  store.addTrade(trade);

  if (isDust(p)) {
    await withdrawExitPlan(p, cfg);
    store.removePosition(p.id);
    store.cooldown(p.address, cfg.cooldownMinutes);
  } else {
    store.save();
  }
  checkDailyLoss();
  // The dashboard only repaints on a snapshot. Without this, a sell is invisible until the
  // next monitor tick — and if the agent is stopped, a manual close never appears at all.
  store.push();
}

/**
 * When this process sells a live position itself — time stop, health exit, the analyst, a
 * manual close — the exit plan GMGN is still holding has nothing left to sell. Left in place,
 * it would wake up against a later balance of the same token.
 */
async function withdrawExitPlan(p: Position, cfg: TradeConfig): Promise<void> {
  if (cfg.mode !== "live" || !p.strategyOrderId) return;
  try {
    await gmgn.cancelStrategyOrder(p.chain, cfg.walletAddress, p.strategyOrderId);
  } catch (e) {
    store.log("warn", `Could not cancel ${p.symbol}'s exit plan on GMGN: ${short(e)}`);
  }
}

function checkDailyLoss(): void {
  const s = store.stats();
  if (store.runState === "running" && s.dayPnlPct <= -store.config.maxDailyLossPct)
    halt(`Daily loss limit hit (${s.dayPnlPct.toFixed(1)}%). Trading halted — resumes automatically at 00:00 UTC, or press Resume agent.`);
}

