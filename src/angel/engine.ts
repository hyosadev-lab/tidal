import { askAnalyst } from "./analyst.ts";
import { gasReserve, liveReady, minPosition, num, refineQuery } from "./core/config.ts";
import * as broker from "./exec/broker.ts";
import * as gmgn from "./exec/market.ts";
import {
  buyableSet,
  entryStrategy,
  evaluateExit,
  gateTally,
  healthExit,
  isDust,
  DUST_FRACTION,
  positionSize,
  runGates,
  score,
  securityRisk,
  toCandidate,
} from "./core/plan.ts";
import { recordSoundings } from "./state/soundings.ts";
import { store } from "./state/store.ts";
import type { Candidate, Decision, Position, StrategyRule, Trade, TradeConfig } from "./core/types.ts";

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

/** True once `stop()` ran after the current cycle began. Only one scan runs at a time. */
let scanGen = 0;
const aborted = () => stopGen !== scanGen;

function short(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/\s+/g, " ").slice(0, 220);
}

/** Coerce, then bound — the fallback is clamped too, so a config value can never widen a limit. */
const clamp = (v: unknown, lo: number, hi: number, fallback: number): number =>
  Math.min(hi, Math.max(lo, num(v, fallback)));

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
      // A token surfacing in more than one feed is a mild confirmation, so keep both labels —
      // but only once each. The signal route returns one row per alert, so a token three smart
      // wallets bought arrives three times, and appending blindly made one feed read as three.
      if (prior) {
        if (!prior.source.split("+").includes(source)) prior.source = `${prior.source}+${source}`;
      } else seen.set(key, c);
      // The 5m feed reports the same columns over a five-minute window, and nearly every row of
      // it is also in the 1h feed — so keeping only the first row seen dropped exactly the
      // numbers an acceleration test needs. Carry them alongside the hourly ones instead. On a
      // row this feed alone surfaced there is no hourly baseline — both windows are then the
      // same five minutes, and `seen_in` is what tells the analyst so.
      if (source === "trending-5m") {
        const t = prior ?? c;
        t.buys5m = c.buys;
        t.sells5m = c.sells;
        t.volume5mUsd = c.volume1hUsd;
      }
      // The signal route reports no flow on any window — a row it alone surfaced would
      // otherwise claim zero buyers rather than an unmeasured one. Blank what it does not
      // measure; `volume_1h_usd` and `swaps_1h` cannot go null on the type, so the brief
      // says what a `smart-money` row's zeros mean. A row another feed already carried
      // keeps that feed's numbers and only picks up the label.
      if (source === "smart-money" && !prior) c.buys = c.sells = c.netBuyUsd = null;
    }
  };

  // The sweep applies no floor of its own: Refine is the only thing that narrows these feeds,
  // and an empty Refine means an unfiltered feed. That is the point — structural quality is
  // `score()`'s job and the operator's, so a hardcoded default here would be a gate wearing a
  // different name. Expect more noise per cycle when Refine is blank.
  type Feed = [rows: Record<string, any>[], source: string];
  const feeds: Promise<Feed>[] = [
    gmgn
      .trending(cfg.chain, { interval: "1h", limit: 50, refine: refineQuery(cfg.refine) })
      .then((r): Feed => [r, "trending-1h"])
      .catch((e): Feed => {
        store.log("warn", `Trending feed failed: ${short(e)}`);
        return [[], "trending-1h"];
      }),
    gmgn
      .trending(cfg.chain, { interval: "5m", limit: 30, refine: refineQuery(cfg.refine) })
      .then((r): Feed => [r, "trending-5m"])
      .catch((): Feed => [[], "trending-5m"]),
  ];
  if (cfg.chain === "sol" || cfg.chain === "bsc")
    feeds.push(
      gmgn
        .trenches(cfg.chain, "completed", 40, refineQuery(cfg.refine, "trenches"))
        .then((r): Feed => [r, "graduated"])
        .catch((): Feed => [[], "graduated"]),
    );
  // Smart-money buys (signal type 12): an alert rather than a rank, and the only feed here
  // that fires before a token is already trending — which is what `score()` calls its
  // strongest prior. Cheap to add, thin to read: the route carries structure but no flow,
  // so most of these rows score low on their own and earn their place by tagging a row the
  // rank feeds also found. Types 6 (price spike) and 7 (ATH) are one array element away and
  // deliberately left out — 7 is almost entirely minutes-old $1-liquidity launches.
  // Refine reaches this route through market cap only; the rest of the panel does not apply.
  feeds.push(
    gmgn
      .signals(cfg.chain, [{ signal_type: [12], mc_min: cfg.refine["marketCapMin"], mc_max: cfg.refine["marketCapMax"] }])
      .then((r): Feed => [r, "smart-money"])
      .catch((): Feed => [[], "smart-money"]),
  );

  // Fetched together, merged in a fixed order. `add` keeps the first row it sees for an address,
  // so merging as they landed left a race deciding whether `volume1hUsd` held an hour or five
  // minutes; the 1h feed goes first for that reason, and the 5m rows arrive knowing they are a
  // second window on a row that already exists.
  for (const [rows, source] of await Promise.all(feeds)) add(rows, source);

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

    const candidates = await gatherCandidates();
    const eligible = candidates.filter((c) => !c.gateFailures.length && !unavailable(c));
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
          : unavailable(c) || `ranked below the top ${ANALYST_SHORTLIST}`;
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
    if (aborted()) {
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
    const opened = await openEntries(decision.entries ?? [], eligible, cfg, slots);
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

async function applyExits(exits: Decision["exits"]): Promise<void> {
  for (const x of exits) {
    const p = store.position(String(x.address ?? ""));
    if (!p) continue;
    await closePosition(p, clamp(x.percent, 1, 100, 100), `analyst: ${String(x.reason ?? "thesis changed").slice(0, 140)}`);
  }
}

/** The model's picks, sized and bought. Returns how many positions were opened. */
async function openEntries(
  entries: Decision["entries"],
  eligible: Candidate[],
  cfg: TradeConfig,
  slots: number,
): Promise<number> {
  // Re-checked here, not reused from the scan: the model's exits ran in between, and
  // closing a position puts its address straight onto cooldown.
  const blocked = new Set(eligible.filter(unavailable).map((c) => c.address.toLowerCase()));
  const byAddress = buyableSet(eligible, blocked);
  let opened = 0;

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

    const size = positionSize(cfg, store.equity, store.cash, conviction) * clamp(e.sizeMultiplier, 0.5, 1.5, 1);
    const floor = minPosition(cfg);
    if (size < floor) {
      const capped = store.cash * 0.9 < store.equity * (cfg.riskPerTradePct / 100) ? "cash" : "the risk budget";
      store.log(
        "warn",
        `${c.symbol} skipped — position would be $${size.toFixed(2)}, under the $${floor} floor (limited by ${capped}; cash $${store.cash.toFixed(2)}).`,
      );
      continue;
    }

    await openPosition(
      c,
      size,
      String(e.thesis ?? "").slice(0, 400),
      conviction,
      clamp(e.stopLossPct, 10, 60, cfg.stopLossPct),
      entryStrategy(cfg, e.strategy),
    );
    opened++;
  }
  return opened;
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
async function bookSell(p: Position, cfg: TradeConfig, qtySold: number, proceeds: number, trade: Trade): Promise<void> {
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
async function reconcile(p: Position, cfg: TradeConfig, holdings: Map<string, number> | null): Promise<boolean> {
  const held = holdings?.get(p.address.toLowerCase());
  const gone = held === undefined ? 0 : p.qty - held;
  if (gone <= p.originalQty * DUST_FRACTION) return false;

  const res = broker.recordExternalSell(cfg, p, gone, "sold on GMGN's side (attached stop/TP or a manual sale)");
  if ("error" in res) return false;
  // The native it fetched is back in the wallet, so it is spendable again — same bookkeeping
  // as a sell this process made, and corrected by the next `syncLiveBalance` either way.
  store.cash += res.proceeds;
  store.log(
    "trade",
    `SELL ${p.symbol} ${((gone / p.originalQty) * 100).toFixed(0)}% — $${res.proceeds.toFixed(2)} (estimated at the last seen price)`,
    "closed outside the agent; booked from the wallet balance",
  );
  await bookSell(p, cfg, gone, res.proceeds, res.trade);
  return isDust(p);
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
      await checkPosition(p, cfg, holdings);
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

/** One position against one fresh price: mirror the wallet, then run the exit plan. */
async function checkPosition(p: Position, cfg: TradeConfig, holdings: Map<string, number> | null): Promise<void> {
  let info: Record<string, any> | null = null;
  try {
    info = await gmgn.tokenInfo(p.chain, p.address);
  } catch (e) {
    store.log("warn", `Price refresh failed for ${p.symbol}: ${short(e)}`);
    return;
  }
  const price = num(info?.price?.price);
  if (price > 0) {
    p.lastPrice = price;
    p.peakPrice = Math.max(p.peakPrice, price);
  }

  if (cfg.mode === "live" && (await reconcile(p, cfg, holdings))) return;

  const health = healthExit(p, info ?? {}, p.entryLiquidityUsd);
  if (health) {
    await closePosition(p, health.percent, health.reason);
    return;
  }

  const exit = evaluateExit(p, cfg);
  if (!exit) return;
  // Live positions carry their whole plan on GMGN's side, so acting on a price rule here
  // would be a second sell for an exit that is already placed. What is left is the two
  // things GMGN was never told: the time stop, and the health exit above it.
  if (cfg.mode === "live" && exit.kind !== "time") return;
  const rung = /^(?:tp|rule)(\d+)$/.exec(exit.kind);
  if (rung?.[1]) p.filledRungs.push(Number(rung[1]));
  await closePosition(p, exit.percent, exit.reason);
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
  await closePosition(p, clamp(percent, 1, 100, 100), "closed by hand from the dashboard");
  return { ok: true };
}

export const _internals = { runScan, runMonitor, gatherCandidates, unavailable };
