import { askAnalyst } from "./analyst.ts";
import { gasReserve, liveReady, minPosition, num, refineQuery } from "./config.ts";
import * as broker from "./broker.ts";
import * as gmgn from "./market.ts";
import { NATIVE_SYMBOL } from "./market.ts";
import {
  buyableSet,
  entryStrategy,
  evaluateExit,
  gateTally,
  healthExit,
  positionSize,
  runGates,
  score,
  securityRisk,
  toCandidate,
} from "./plan.ts";
import { recordSoundings } from "./soundings.ts";
import { store } from "./store.ts";
import type { Candidate, Position, StrategyRule, TradeConfig } from "./types.ts";

/** How many of the eligible rows, best score first, are put in front of the analyst. */
const ANALYST_SHORTLIST = 18;

let monitorTimer: NodeJS.Timeout | null = null;
let scanTimer: NodeJS.Timeout | null = null;
let kickoffTimer: NodeJS.Timeout | null = null;
let scanning = false;
let monitoring = false;

/**
 * Bumped by `stop()`. Clearing the timers only prevents the *next* cycle — a scan already in
 * flight can be parked on an LLM call for half a minute and would then go on to buy, long
 * after the operator pressed Stop. A cycle captures this at its start and abandons itself at
 * every await that precedes a spend once the number moves. A manual "Scan now" while stopped
 * never sees it move, so that path still works.
 */
let stopGen = 0;

// ── scan ──────────────────────────────────────────────────────────────

async function gatherCandidates(): Promise<Candidate[]> {
  const cfg = store.config;
  const seen = new Map<string, Candidate>();

  const add = (rows: Record<string, any>[], source: string) => {
    for (const r of rows) {
      const c = toCandidate(r, source);
      if (!c.address) continue;
      const key = c.address.toLowerCase();
      const prior = seen.get(key);
      // A token surfacing in more than one feed is a mild confirmation, so keep both labels.
      if (prior) prior.source = `${prior.source}+${source}`;
      else seen.set(key, c);
    }
  };

  // The sweep applies no floor of its own: Refine is the only thing that narrows these feeds,
  // and an empty Refine means an unfiltered feed. That is the point — structural quality is
  // `score()`'s job and the operator's, so a hardcoded default here would be a gate wearing a
  // different name. Expect more noise per cycle when Refine is blank.
  const feeds: Promise<void>[] = [
    gmgn
      .trending(cfg.chain, { interval: "1h", limit: 50, refine: refineQuery(cfg.refine) })
      .then((r) => add(r, "trending-1h"))
      .catch((e) => {
        store.log("warn", `Trending feed failed: ${short(e)}`);
      }),
    gmgn
      .trending(cfg.chain, { interval: "5m", limit: 30, refine: refineQuery(cfg.refine) })
      .then((r) => add(r, "trending-5m"))
      .catch(() => undefined),
  ];
  if (cfg.chain === "sol" || cfg.chain === "bsc")
    feeds.push(
      gmgn
        .trenches(cfg.chain, "completed", 40, refineQuery(cfg.refine, "trenches"))
        .then((r) => add(r, "graduated"))
        .catch(() => undefined),
    );

  await Promise.all(feeds);

  const all = [...seen.values()];
  for (const c of all) {
    c.gateFailures = runGates(c);
    c.score = c.gateFailures.length ? 0 : score(c);
  }
  return all.sort((a, b) => b.score - a.score);
}

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
      `Wallet: ${bal.toFixed(4)} ${NATIVE_SYMBOL[cfg.chain]} · $${store.cash.toFixed(2)} spendable (${gasReserve(cfg)} held back for gas).`,
    );
    return true;
  } catch (e) {
    store.log("warn", `Wallet balance check failed: ${short(e)} — skipping entries this cycle.`);
    return false;
  }
}

/** True once `stop()` ran after the current cycle began. Only one scan runs at a time. */
let scanGen = 0;
const aborted = () => stopGen !== scanGen;

async function runScan(): Promise<void> {
  if (scanning) return;
  scanning = true;
  scanGen = stopGen;
  store.busy = true;
  const cfg = store.config;

  try {
    store.rollDay();
    const balanceOk = await syncLiveBalance();
    const cycle = store.bumpCycle();
    store.lastRunAt = Date.now();
    store.phase = "scanning";
    store.push();

    const all = await gatherCandidates();
    const held = new Set(store.positions.map((p) => p.address.toLowerCase()));
    const eligible = all.filter(
      (c) =>
        !c.gateFailures.length &&
        !held.has(c.address.toLowerCase()) &&
        !store.onCooldown(c.address) &&
        !store.isBlacklisted(c.address),
    );
    // Why each row did or did not reach the model, decided here rather than in the dashboard:
    // held / cooldown / blacklist live in the store and never travel on a Candidate. Written
    // before the soundings so calibrate can tell the rows the model actually saw from the ones
    // that merely scored well.
    const shortlist = eligible.slice(0, ANALYST_SHORTLIST);
    const shown = new Set(shortlist.map((c) => c.address));
    for (const c of all)
      c.analystNote = c.gateFailures.length
        ? ""
        : shown.has(c.address)
          ? "sent"
          : store.position(c.address)
            ? "already held"
            : store.onCooldown(c.address)
              ? "on cooldown after a recent exit"
              : store.isBlacklisted(c.address)
                ? "blacklisted"
                : `ranked below the top ${ANALYST_SHORTLIST}`;
    store.lastCandidates = all.slice(0, 40);
    // The whole sweep, not just the shown 40: `calibrate.ts` needs the rows nobody looked at
    // as much as the ones that scored well, or it only measures what we already believed.
    recordSoundings(cycle, cfg.chain, all);
    store.log(
      "info",
      `Cycle ${cycle}: ${all.length} tokens scanned, ${eligible.length} through the gates.`,
      eligible.length ? eligible.slice(0, 8).map((c) => `${c.symbol} ${c.score}`).join("  ") : undefined,
    );
    // Which gate did the killing. The thresholds are fixed now, so the only thing left worth
    // measuring is which of them actually fires — a gate that never fires is dead weight, and
    // one that rejects most of the sweep is quietly the whole strategy. Counts exceed the
    // number of rejects: a token can fail several gates at once.
    const tally = gateTally(all);
    if (tally) store.log("info", `Gates: ${tally}`);

    if (!eligible.length && !store.positions.length) {
      store.phase = "idle";
      return;
    }

    store.phase = "analysing";
    store.push();

    const decision = await askAnalyst(shortlist, cfg.maxOpenPositions - store.positions.length);
    if (!decision) return;
    if (aborted()) {
      store.log("info", "Cycle abandoned — stopped while the analyst was thinking.");
      return;
    }
    if (decision.notes) store.log("model", decision.notes);

    // Model-requested exits first — freeing a slot may enable an entry below.
    for (const x of decision.exits ?? []) {
      const p = store.position(String(x.address ?? ""));
      if (!p) continue;
      const pct = Math.max(1, Math.min(100, num(x.percent, 100)));
      await closePosition(p, pct, `analyst: ${String(x.reason ?? "thesis changed").slice(0, 140)}`);
    }

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
    // Re-checked here, not reused from the scan: the model's exits ran in between, and
    // closing a position puts its address straight onto cooldown.
    const blocked = new Set<string>();
    for (const c of eligible)
      if (store.position(c.address) || store.onCooldown(c.address) || store.isBlacklisted(c.address))
        blocked.add(c.address.toLowerCase());
    const byAddress = buyableSet(eligible, blocked);
    let opened = 0;

    for (const e of decision.entries ?? []) {
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
      const conviction = Math.max(0, Math.min(100, num(e.conviction, c.score)));
      if (conviction < 40) {
        store.log("info", `${c.symbol} skipped — conviction ${conviction} below the 40 floor.`);
        continue;
      }
      const mult = Math.max(0.5, Math.min(1.5, num(e.sizeMultiplier, 1)));
      const stop = Math.max(10, Math.min(60, num(e.stopLossPct, cfg.stopLossPct)));
      const strategy = entryStrategy(cfg, e.strategy);
      const size = positionSize(cfg, store.equity, store.cash, conviction) * mult;
      const floor = minPosition(cfg);
      if (size < floor) {
        const capped = store.cash * 0.9 < store.equity * (cfg.riskPerTradePct / 100) ? "cash" : "the risk budget";
        store.log(
          "warn",
          `${c.symbol} skipped — position would be $${size.toFixed(2)}, under the $${floor} floor (limited by ${capped}; cash $${store.cash.toFixed(2)}).`,
        );
        continue;
      }
      await openPosition(c, size, String(e.thesis ?? "").slice(0, 400), conviction, stop, strategy);
      opened++;
    }
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

// ── execution ─────────────────────────────────────────────────────────

async function openPosition(
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
  if (aborted()) {
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

async function closePosition(p: Position, percentOfOriginal: number, reason: string): Promise<void> {
  const cfg = store.config;
  try {
    const res = await broker.sell(store, cfg, p, percentOfOriginal, reason, p.entryLiquidityUsd);
    if ("error" in res) {
      store.log("error", `Sell ${p.symbol} failed: ${res.error}`);
      return;
    }
    p.qty = Math.max(0, p.qty - res.qtySold);
    p.realisedUsd += res.proceeds;
    store.addTrade(res.trade);

    const pnl = res.trade.pnlUsd ?? 0;
    store.log(
      "trade",
      `SELL ${p.symbol} ${percentOfOriginal}% — $${res.proceeds.toFixed(2)} · ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} (${(res.trade.pnlPct ?? 0).toFixed(1)}%)`,
      reason,
    );

    const dust = p.qty * p.lastPrice < 1 || p.qty <= p.originalQty * 0.02;
    if (dust) {
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
  } catch (e) {
    store.log("error", `Sell ${p.symbol} errored: ${short(e)}`);
  }
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

async function readHoldings(cfg: TradeConfig): Promise<Map<string, number> | null> {
  try {
    return await gmgn.walletHoldings(cfg.chain, cfg.walletAddress);
  } catch (e) {
    store.log("warn", `Wallet holdings read failed: ${short(e)} — positions are not mirrored this tick.`);
    return null;
  }
}

/**
 * Mirrors one live position onto what the wallet actually holds. The exits run on GMGN's side,
 * so a position shrinks or disappears without this process selling anything — and the operator
 * can sell from GMGN's UI too. Whatever left the wallet is booked here.
 *
 * An unreadable wallet, or an address the holdings page did not carry, closes nothing: showing
 * a position a moment too long is recoverable, dropping a live one is not. The fill price is
 * GMGN's, not ours, so the booked PnL is an estimate at the last seen price.
 *
 * Returns true when the position is gone and the tick should move on.
 */
function reconcile(p: Position, cfg: TradeConfig, holdings: Map<string, number> | null): boolean {
  const held = holdings?.get(p.address.toLowerCase());
  const gone = held === undefined ? 0 : p.qty - held;
  if (gone <= p.originalQty * 0.02) return false;

  const res = broker.recordExternalSell(cfg, p, gone, "sold on GMGN's side (attached stop/TP or a manual sale)");
  if ("error" in res) return false;
  p.qty = Math.max(0, held ?? 0);
  p.realisedUsd += res.proceeds;
  // The native it fetched is back in the wallet, so it is spendable again — same bookkeeping
  // as a sell this process made, and corrected by the next `syncLiveBalance` either way.
  store.cash += res.proceeds;
  store.addTrade(res.trade);
  store.log(
    "trade",
    `SELL ${p.symbol} ${((gone / p.originalQty) * 100).toFixed(0)}% — $${res.proceeds.toFixed(2)} (estimated at the last seen price)`,
    "closed outside the agent; booked from the wallet balance",
  );

  if (p.qty * p.lastPrice < 1 || p.qty <= p.originalQty * 0.02) {
    store.removePosition(p.id);
    store.cooldown(p.address, cfg.cooldownMinutes);
    store.push();
    return true;
  }
  store.save();
  return false;
}

function checkDailyLoss(): void {
  const s = store.stats();
  if (store.runState === "running" && s.dayPnlPct <= -store.config.maxDailyLossPct) {
    store.runState = "halted";
    store.haltReason = `Daily loss limit hit (${s.dayPnlPct.toFixed(1)}%). Trading halted until tomorrow or a manual restart.`;
    stop(true);
    store.log("warn", store.haltReason);
    store.push();
  }
}

// ── monitor ───────────────────────────────────────────────────────────

async function runMonitor(): Promise<void> {
  if (monitoring || !store.positions.length) return;
  monitoring = true;
  const gen = stopGen;
  try {
    const cfg = store.config;
    // One read for the whole wallet, before anything else: in live mode GMGN's copy of the
    // book is the real one, and every position below is checked against it.
    const holdings = cfg.mode === "live" ? await readHoldings(cfg) : null;

    for (const p of [...store.positions]) {
      // One price read per position, so a tick over a full book outlives a Stop by a while.
      // Whatever is left of it belongs to a run the operator ended.
      if (stopGen !== gen) break;
      let info: Record<string, any> | null = null;
      try {
        info = await gmgn.tokenInfo(p.chain, p.address);
      } catch (e) {
        store.log("warn", `Price refresh failed for ${p.symbol}: ${short(e)}`);
        continue;
      }
      const price = num(info?.price?.price);
      if (price > 0) {
        p.lastPrice = price;
        p.peakPrice = Math.max(p.peakPrice, price);
      }

      if (cfg.mode === "live" && reconcile(p, cfg, holdings)) continue;

      const health = healthExit(p, info ?? {}, p.entryLiquidityUsd);
      if (health) {
        await closePosition(p, health.percent, health.reason);
        continue;
      }

      const exit = evaluateExit(p, cfg);
      // Live positions carry their whole plan on GMGN's side, so acting on a price rule here
      // would be a second sell for an exit that is already placed. What is left is the two
      // things GMGN was never told: the time stop, and the health exit above it.
      if (exit && cfg.mode === "live" && exit.kind !== "time") continue;
      if (exit) {
        const rung = /^(?:tp|rule)(\d+)$/.exec(exit.kind);
        if (rung?.[1]) p.filledRungs.push(Number(rung[1]));
        await closePosition(p, exit.percent, exit.reason);
      }
    }
    store.save();
    store.markEquity();
    store.push();
  } catch (e) {
    store.log("error", `Monitor tick failed: ${short(e)}`);
  } finally {
    monitoring = false;
  }
}

function short(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/\s+/g, " ").slice(0, 220);
}

// ── lifecycle ─────────────────────────────────────────────────────────

/**
 * The only place timers are installed, and it clears whatever is already there first.
 * `start()` reaches this after an await in live mode, so two clicks on Start can both get
 * here: without the clear, the second set of handles overwrites the first and that first
 * pair keeps firing forever — an agent the dashboard calls stopped, still scanning and
 * buying, with no handle left to cancel it.
 */
function arm(monitorSeconds: number, intervalMinutes: number, firstScanMs: number | null): void {
  disarm();
  monitorTimer = setInterval(() => void runMonitor(), monitorSeconds * 1000);
  scanTimer = setInterval(() => void runScan(), intervalMinutes * 60_000);
  if (firstScanMs !== null) kickoffTimer = setTimeout(() => void runScan(), firstScanMs);
}

function disarm(): void {
  if (monitorTimer) clearInterval(monitorTimer);
  if (scanTimer) clearInterval(scanTimer);
  if (kickoffTimer) clearTimeout(kickoffTimer);
  monitorTimer = scanTimer = kickoffTimer = null;
}

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

  // The best case is conviction 100 with no size multiplier. If even that lands under
  // the floor, every candidate will be skipped forever — say so now, not next cycle.
  const ceiling = store.equity * (cfg.riskPerTradePct / 100);
  const floor = minPosition(cfg);
  if (ceiling < floor) {
    const needed = Math.ceil((floor / Math.max(1, store.equity)) * 100);
    return {
      ok: false,
      error:
        `With $${store.equity.toFixed(2)} and ${cfg.riskPerTradePct}% risk per trade, the largest position is $${ceiling.toFixed(2)} — under the $${floor} minimum for ${cfg.chain.toUpperCase()}. ` +
        (needed <= 25
          ? `Raise risk per trade to at least ${needed}%, or trade a larger balance.`
          : `Reaching the floor would need ${needed}% of the balance in a single position, which the ${cfg.chain.toUpperCase()} settings cannot support. Trade a larger balance or a cheaper chain.`),
    };
  }

  store.rollDay();
  store.runState = "running";
  store.haltReason = "";
  store.log(
    "info",
    `Started on ${cfg.chain.toUpperCase()} in ${cfg.mode} mode — scanning every ${cfg.intervalMinutes}m, checking exits every ${cfg.monitorSeconds}s.`,
  );

  arm(cfg.monitorSeconds, cfg.intervalMinutes, 1500);
  store.nextRunAt = Date.now() + 1500;
  store.push();
  return { ok: true };
}

export function stop(keepState = false): void {
  stopGen++;
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
  arm(store.config.monitorSeconds, store.config.intervalMinutes, null);
  store.nextRunAt = Date.now() + store.config.intervalMinutes * 60_000;
  store.push();
}

export async function scanNow(): Promise<void> {
  await runScan();
}

export async function manualClose(positionId: string, percent = 100): Promise<{ ok: boolean; error?: string }> {
  const p = store.positions.find((x) => x.id === positionId);
  if (!p) return { ok: false, error: "position not found" };
  await closePosition(p, Math.max(1, Math.min(100, percent)), "closed by hand from the dashboard");
  return { ok: true };
}

export const _internals = { runScan, runMonitor, gatherCandidates };
