import { runAgent, type Tool } from "../agent.ts";
import { loadSkills, skillIndex, skillTool } from "../skills.ts";
import { SKIP, gasReserve, liveReady, minPosition } from "./config.ts";
import * as broker from "./broker.ts";
import * as gmgn from "./gmgn.ts";
import { num } from "./gmgn.ts";
import {
  buyableSet,
  evaluateExit,
  healthExit,
  pnlPct,
  positionSize,
  runGates,
  score,
  securityRisk,
  systemPrompt,
  toCandidate,
  userPromptBlock,
} from "./plan.ts";
import { store } from "./store.ts";
import type { Candidate, Decision, Position } from "./types.ts";

let monitorTimer: NodeJS.Timeout | null = null;
let scanTimer: NodeJS.Timeout | null = null;
let scanning = false;
let monitoring = false;

// ── model plumbing ────────────────────────────────────────────────────

/**
 * The engine loads `trading/skills/`, not the top-level `skills/`. Those are written for an
 * interactive assistant with a shell — they open by telling the model to run `gmgn-cli config`
 * and to ask the user for an API key. There is no user in this loop and no shell to run them
 * in. `index.ts` still loads them; they are correct there.
 */
const skills = await loadSkills(new URL("skills", import.meta.url).pathname).catch(() => []);

/**
 * Candidates the analyst turned up itself via `find_tokens`, keyed by lowercased
 * address. Reset each cycle. Gates have already been run on every entry — being in
 * here is not permission to buy, only permission to be considered.
 */
let discovered = new Map<string, Candidate>();

/**
 * Read-only tools for the analyst. There is deliberately no bash and no swap tool
 * here: execution is the engine's job, and an analyst that cannot spend money
 * cannot be talked into spending money by something it read in a token name.
 */
const analystTools: Record<string, Tool> = {
  find_tokens: {
    description:
      "Search for tokens the pre-scan did not surface. feed: trending (rank by volume), " +
      "trenches (launchpad graduates), signals (smart-money buys, price spikes, ATH), " +
      "hot_searches (most searched). Returns each token with the entry gates already applied — " +
      "rows with gate_failures cannot be bought no matter how good they look. Call this more than " +
      "once with different parameters if the operator's instructions call for it.",
    parameters: {
      type: "object",
      properties: {
        feed: { type: "string", enum: ["trending", "trenches", "signals", "hot_searches"] },
        interval: { type: "string", description: "trending/hot_searches only: 1m, 5m, 1h, 6h, 24h. Default 1h." },
        trench_type: { type: "string", enum: ["completed", "near_completion", "new_creation"] },
        signal_types: { type: "array", items: { type: "number" }, description: "signals only: 12 = smart money buy, 6 = price spike, 7 = ATH." },
        platforms: { type: "array", items: { type: "string" }, description: "trending only: launchpad names, e.g. Pump.fun, letsbonk, fourmeme." },
        min_liquidity_usd: { type: "number" },
        min_volume_usd: { type: "number" },
        min_smart_money: { type: "number" },
        min_kols: { type: "number" },
        max_age: { type: "string", description: "trending only: max token age with a unit, e.g. 30m, 6h, 7d." },
        min_age: { type: "string", description: "trending only: min token age with a unit." },
        limit: { type: "number", description: "Max 50." },
      },
      required: ["feed"],
    },
    run: async (a: Record<string, any>) => {
      const cfg = store.config;
      const limit = Math.min(50, Math.max(1, num(a.limit, 30)));
      let rows: Record<string, any>[] = [];
      const feed = String(a.feed);

      // The floors here are the gate thresholds and the config's, not the model's: a request
      // for looser liquidity than either allows is silently clamped back up.
      if (feed === "trending")
        rows = await gmgn.trending(cfg.chain, {
          interval: String(a.interval ?? "1h"),
          limit,
          minLiquidity: Math.max(SKIP.minLiquidityUsd, num(a.min_liquidity_usd)),
          minVolume: Math.max(cfg.minVolume1hUsd, num(a.min_volume_usd)),
          minSmartDegen: Math.max(SKIP.minSmartDegenCount, num(a.min_smart_money)) || undefined,
          minRenowned: num(a.min_kols) || undefined,
          maxCreated: a.max_age ? String(a.max_age) : undefined,
          minCreated: a.min_age ? String(a.min_age) : undefined,
          platforms: Array.isArray(a.platforms) ? a.platforms.map(String).slice(0, 12) : undefined,
        });
      else if (feed === "trenches") rows = await gmgn.trenches(cfg.chain, String(a.trench_type ?? "completed"), limit);
      else if (feed === "signals")
        rows = await gmgn.signals(cfg.chain, Array.isArray(a.signal_types) ? a.signal_types.map(Number) : undefined);
      else if (feed === "hot_searches") rows = await gmgn.hotSearches(cfg.chain, String(a.interval ?? "1h"), limit);
      else return { error: `unknown feed: ${feed}` };

      const held = new Set(store.positions.map((p) => p.address.toLowerCase()));
      const out = rows.slice(0, limit).map((r) => {
        const c = toCandidate(r, `find:${feed}`);
        c.gateFailures = runGates(c);
        c.score = c.gateFailures.length ? 0 : score(c);
        const key = c.address.toLowerCase();
        if (c.address) discovered.set(key, c);
        const blocked = held.has(key)
          ? "already held"
          : store.onCooldown(c.address)
            ? "on cooldown"
            : store.isBlacklisted(c.address)
              ? "blacklisted"
              : "";
        return {
          address: c.address,
          symbol: c.symbol,
          structure_score: c.score,
          mcap_usd: Math.round(c.marketCapUsd),
          liquidity_usd: Math.round(c.liquidityUsd),
          volume_1h_usd: Math.round(c.volume1hUsd),
          change_1h_pct: Number(c.change1hPct.toFixed(1)),
          holders: c.holderCount,
          smart_money: c.smartDegenCount,
          kols: c.renownedCount,
          age_minutes: Math.round(c.ageMinutes),
          launchpad: c.launchpad,
          gate_failures: c.gateFailures,
          blocked,
        };
      });
      return { feed, returned: out.length, tokens: out };
    },
  },
  token_detail: {
    description: "Full detail for one token: price, liquidity, holders, socials, dev status, smart money counts.",
    parameters: {
      type: "object",
      properties: { address: { type: "string" } },
      required: ["address"],
    },
    run: async ({ address }: { address: string }) => {
      const info = await gmgn.tokenInfo(store.config.chain, address);
      return {
        symbol: info?.symbol,
        price: info?.price?.price,
        liquidity: info?.liquidity,
        holder_count: info?.holder_count,
        market_cap: num(info?.price?.price) * num(info?.circulating_supply),
        volume_1h: info?.price?.volume_1h,
        volume_24h: info?.price?.volume_24h,
        buys_1h: info?.price?.buys_1h,
        sells_1h: info?.price?.sells_1h,
        smart_wallets: info?.wallet_tags_stat?.smart_wallets,
        renowned_wallets: info?.wallet_tags_stat?.renowned_wallets,
        sniper_wallets: info?.wallet_tags_stat?.sniper_wallets,
        top_10_holder_rate: info?.stat?.top_10_holder_rate,
        dev_status: info?.dev?.creator_token_status,
        fresh_wallet_rate: info?.stat?.fresh_wallet_rate,
        twitter: info?.link?.twitter_username,
        website: info?.link?.website,
        created_at: info?.creation_timestamp,
      };
    },
  },
  token_security: {
    description: "Security audit for a token: honeypot, taxes, rug ratio, holder concentration, dev holdings.",
    parameters: { type: "object", properties: { address: { type: "string" } }, required: ["address"] },
    run: ({ address }: { address: string }) => gmgn.tokenSecurity(store.config.chain, address),
  },
  top_holders: {
    description: "Top holders for a token. Optional tag filter: smart_degen, renowned, sniper, dev, bundler.",
    parameters: {
      type: "object",
      properties: { address: { type: "string" }, tag: { type: "string" }, limit: { type: "number" } },
      required: ["address"],
    },
    run: async ({ address, tag, limit }: { address: string; tag?: string; limit?: number }) => {
      const rows = await gmgn.tokenHolders(store.config.chain, address, Math.min(30, limit ?? 15), tag);
      return rows.map((h) => ({
        addr: String(h.address ?? "").slice(0, 8),
        pct: num(h.amount_percentage) * 100,
        avg_cost: h.avg_cost,
        unrealized_pnl: h.unrealized_pnl,
        sold_pct: num(h.sell_amount_percentage) * 100,
        buys: h.buy_tx_count_cur,
        sells: h.sell_tx_count_cur,
        tags: h.tags,
      }));
    },
  },
  price_history: {
    description: "Recent candles for a token. resolution: 1m, 5m, 15m, 1h. Returns the last `bars` candles.",
    parameters: {
      type: "object",
      properties: { address: { type: "string" }, resolution: { type: "string" }, bars: { type: "number" } },
      required: ["address"],
    },
    run: async ({ address, resolution, bars }: { address: string; resolution?: string; bars?: number }) => {
      const res = resolution ?? "5m";
      const n = Math.min(60, bars ?? 24);
      const perBar = res === "1m" ? 60 : res === "5m" ? 300 : res === "15m" ? 900 : 3600;
      const to = Math.floor(Date.now() / 1000);
      const rows = await gmgn.kline(store.config.chain, address, res, to - perBar * n, to);
      return rows.slice(-n).map((c) => ({ t: c.time, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume }));
    },
  },
  smart_money_flow: {
    description: "Recent buys and sells from wallets GMGN tags as smart money on this chain.",
    parameters: { type: "object", properties: { limit: { type: "number" } } },
    run: async ({ limit }: { limit?: number }) => {
      const rows = await gmgn.smartMoney(store.config.chain, Math.min(100, limit ?? 50));
      return rows.slice(0, 60).map((t) => ({
        sym: t.base_token?.symbol,
        addr: t.base_address,
        side: t.side,
        usd: t.amount_usd,
        full_position: t.is_open_or_close,
        at: t.timestamp,
      }));
    },
  },
};

Object.assign(analystTools, skillTool(skills));

function extractJson(text: string): Decision | null {
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  if (start < 0) return null;
  // Walk back from the end so trailing commentary doesn't break the parse.
  for (let end = cleaned.lastIndexOf("}"); end > start; end = cleaned.lastIndexOf("}", end - 1)) {
    try {
      const o = JSON.parse(cleaned.slice(start, end + 1));
      return {
        entries: Array.isArray(o.entries) ? o.entries : [],
        exits: Array.isArray(o.exits) ? o.exits : [],
        notes: typeof o.notes === "string" ? o.notes : "",
      };
    } catch {
      /* try the next closing brace */
    }
  }
  return null;
}

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

  const feeds: Promise<void>[] = [
    gmgn
      .trending(cfg.chain, {
        interval: "1h",
        limit: 50,
        minLiquidity: SKIP.minLiquidityUsd,
        minVolume: cfg.minVolume1hUsd,
        minSmartDegen: SKIP.minSmartDegenCount || undefined,
      })
      .then((r) => add(r, "trending-1h"))
      .catch((e) => {
        store.log("warn", `Trending feed failed: ${short(e)}`);
      }),
    gmgn
      .trending(cfg.chain, { interval: "5m", limit: 30, minLiquidity: SKIP.minLiquidityUsd })
      .then((r) => add(r, "trending-5m"))
      .catch(() => undefined),
  ];
  if (cfg.chain === "sol" || cfg.chain === "bsc")
    feeds.push(
      gmgn
        .trenches(cfg.chain, "completed", 40)
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
async function syncLiveBalance(): Promise<boolean> {
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

const NATIVE_SYMBOL: Record<string, string> = { sol: "SOL", bsc: "BNB", base: "ETH", eth: "ETH" };

async function runScan(): Promise<void> {
  if (scanning) return;
  scanning = true;
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
    store.lastCandidates = all.slice(0, 40);
    store.log(
      "info",
      `Cycle ${cycle}: ${all.length} tokens scanned, ${eligible.length} through the gates.`,
      eligible.length ? eligible.slice(0, 8).map((c) => `${c.symbol} ${c.score}`).join("  ") : undefined,
    );

    if (!eligible.length && !store.positions.length) {
      store.phase = "idle";
      return;
    }

    store.phase = "analysing";
    store.push();

    discovered = new Map();
    const decision = await askAnalyst(eligible.slice(0, 18), cfg.maxOpenPositions - store.positions.length);
    if (!decision) return;
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
    const blocked = new Set(held);
    for (const c of discovered.values()) {
      const key = c.address.toLowerCase();
      if (store.onCooldown(c.address) || store.isBlacklisted(c.address)) blocked.add(key);
    }
    const byAddress = buyableSet(eligible, [...discovered.values()], blocked);
    let opened = 0;

    for (const e of decision.entries ?? []) {
      if (opened >= slots) break;
      const c = byAddress.get(String(e.address ?? "").toLowerCase());
      if (!c) {
        store.log(
          "warn",
          `Analyst picked ${String(e.symbol ?? e.address).slice(0, 20)}, which is not eligible — it failed a gate, is on cooldown, or was never scanned. Skipped.`,
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
      await openPosition(c, size, String(e.thesis ?? "").slice(0, 400), conviction, stop);
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

async function askAnalyst(candidates: Candidate[], slots: number): Promise<Decision | null> {
  const cfg = store.config;
  if (!process.env.OPENROUTER_API_KEY) {
    store.log("error", "No OPENROUTER_API_KEY — the analyst can't run. Set it in .env and restart.");
    return null;
  }

  const book = store.positions.map((p) => ({
    address: p.address,
    symbol: p.symbol,
    pnl_pct: Number(pnlPct(p).toFixed(1)),
    age_minutes: Math.round((Date.now() - p.openedAt) / 60_000),
    size_usd: Number((p.qty * p.lastPrice).toFixed(2)),
    rungs_filled: p.filledRungs.length,
    thesis: p.thesis,
  }));

  const brief = {
    chain: cfg.chain,
    mode: cfg.mode,
    equity_usd: Number(store.equity.toFixed(2)),
    cash_usd: Number(store.cash.toFixed(2)),
    free_slots: slots,
    day_pnl_pct: Number(store.stats().dayPnlPct.toFixed(2)),
    open_positions: book,
    candidates: candidates.map((c) => ({
      address: c.address,
      symbol: c.symbol,
      structure_score: c.score,
      price: c.priceUsd,
      mcap_usd: Math.round(c.marketCapUsd),
      liquidity_usd: Math.round(c.liquidityUsd),
      volume_1h_usd: Math.round(c.volume1hUsd),
      change_5m_pct: Number(c.change5mPct.toFixed(1)),
      change_1h_pct: Number(c.change1hPct.toFixed(1)),
      swaps_1h: c.swaps1h,
      holders: c.holderCount,
      smart_money: c.smartDegenCount,
      kols: c.renownedCount,
      rug_ratio: c.rugRatio,
      top10_rate: c.top10HolderRate,
      age_minutes: Math.round(c.ageMinutes),
      launchpad: c.launchpad,
      seen_in: c.source,
    })),
  };

  const system = systemPrompt(cfg) + userPromptBlock(cfg) + skillIndex(skills);
  const prompt = `Cycle brief:\n\n${JSON.stringify(brief, null, 1)}\n\nReturn the JSON decision.`;

  try {
    // Discovery calls come out of the same budget as research, so the ceiling went up
    // with find_tokens. Raise it further only if logs show the analyst running out.
    const res = await runAgent(prompt, { tools: analystTools, system, maxSteps: 22 });
    const decision = extractJson(res.text);
    if (!decision) {
      store.log("warn", "Analyst reply wasn't valid JSON — no action this cycle.", res.text.slice(0, 400));
      return null;
    }
    return decision;
  } catch (e) {
    store.log("error", `Analyst call failed: ${short(e)}`);
    return null;
  }
}

// ── execution ─────────────────────────────────────────────────────────

async function openPosition(
  c: Candidate,
  usd: number,
  thesis: string,
  conviction: number,
  stopLossPct: number,
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

  try {
    const res = await broker.buy(store, cfg, c, usd, thesis, conviction, stopLossPct);
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
      store.removePosition(p.id);
      store.cooldown(p.address, cfg.cooldownMinutes);
    } else {
      store.save();
    }
    checkDailyLoss();
  } catch (e) {
    store.log("error", `Sell ${p.symbol} errored: ${short(e)}`);
  }
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
  try {
    const cfg = store.config;
    for (const p of [...store.positions]) {
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

      const health = healthExit(p, info ?? {}, p.entryLiquidityUsd);
      if (health) {
        await closePosition(p, health.percent, health.reason);
        continue;
      }

      const exit = evaluateExit(p, cfg);
      if (exit) {
        const rung = /^tp(\d+)$/.exec(exit.kind);
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

  monitorTimer = setInterval(() => void runMonitor(), cfg.monitorSeconds * 1000);
  scanTimer = setInterval(() => void runScan(), cfg.intervalMinutes * 60_000);
  store.nextRunAt = Date.now() + 1500;
  setTimeout(() => void runScan(), 1500);
  store.push();
  return { ok: true };
}

export function stop(keepState = false): void {
  if (monitorTimer) clearInterval(monitorTimer);
  if (scanTimer) clearInterval(scanTimer);
  monitorTimer = scanTimer = null;
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
  if (monitorTimer) clearInterval(monitorTimer);
  if (scanTimer) clearInterval(scanTimer);
  monitorTimer = setInterval(() => void runMonitor(), store.config.monitorSeconds * 1000);
  scanTimer = setInterval(() => void runScan(), store.config.intervalMinutes * 60_000);
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

export const _internals = { runScan, runMonitor, gatherCandidates, extractJson, analystTools };
