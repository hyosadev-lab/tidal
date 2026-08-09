import { runAgent, type Tool } from "../agent/llm.ts";
import { loadSkills, skillIndex, skillTool } from "../agent/skills.ts";
import { refineQuery } from "./config.ts";
import * as gmgn from "./market.ts";
import { num } from "./market.ts";
import { pnlPct, runGates, score, systemPrompt, toCandidate, userPromptBlock } from "./plan.ts";
import { store } from "./store.ts";
import type { Candidate, Decision } from "./types.ts";

/**
 * The model half of a cycle: what the analyst is told, what it may look up, and what
 * comes back. `engine.ts` owns everything that spends money; nothing here does.
 *
 * The engine loads `trading/skills/`, not the top-level `skills/`. Those are written for an
 * interactive assistant with a shell — they open by telling the model to run `gmgn-cli config`
 * and to ask the user for an API key. There is no user in this loop and no shell to run them
 * in. `cli.ts` still loads them; they are correct there.
 */
const skills = await loadSkills(new URL("skills", import.meta.url).pathname).catch(() => []);

/**
 * Read-only tools for the analyst. There is deliberately no bash and no swap tool
 * here: execution is the engine's job, and an analyst that cannot spend money
 * cannot be talked into spending money by something it read in a token name.
 *
 * `discovered` collects what `find_tokens` turned up, keyed by lowercased address, and is
 * handed back to the caller when the run ends. Gates have already been run on every entry —
 * being in there is not permission to buy, only permission to be considered.
 */
function analystTools(discovered: Map<string, Candidate>): Record<string, Tool> {
  const tools: Record<string, Tool> = {
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

        // These were clamped up to the gate thresholds until those gates were dropped. Depth and
        // smart-money count no longer disqualify anything, so there is nothing left to clamp to:
        // the model's own numbers go through, and every row still passes runGates below.
        if (feed === "trending")
          rows = await gmgn.trending(cfg.chain, {
            interval: String(a.interval ?? "1h"),
            limit,
            minLiquidity: num(a.min_liquidity_usd) || undefined,
            minVolume: num(a.min_volume_usd) || undefined,
            minSmartDegen: num(a.min_smart_money) || undefined,
            minRenowned: num(a.min_kols) || undefined,
            maxCreated: a.max_age ? String(a.max_age) : undefined,
            minCreated: a.min_age ? String(a.min_age) : undefined,
            platforms: Array.isArray(a.platforms) ? a.platforms.map(String).slice(0, 12) : undefined,
            refine: refineQuery(cfg.refine),
          });
        else if (feed === "trenches")
          rows = await gmgn.trenches(cfg.chain, String(a.trench_type ?? "completed"), limit, refineQuery(cfg.refine, "trenches"));
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
  return Object.assign(tools, skillTool(skills));
}

export function extractJson(text: string): Decision | null {
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

/** What the model found on its own, alongside what it decided. Both are per-cycle. */
export type AnalystResult = { decision: Decision | null; discovered: Candidate[] };

export async function askAnalyst(candidates: Candidate[], slots: number): Promise<AnalystResult> {
  const cfg = store.config;
  const discovered = new Map<string, Candidate>();
  const nothing = (): AnalystResult => ({ decision: null, discovered: [...discovered.values()] });

  if (!process.env.OPENROUTER_API_KEY) {
    store.log("error", "No OPENROUTER_API_KEY — the analyst can't run. Set it in .env and restart.");
    return nothing();
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
    const res = await runAgent(prompt, { tools: analystTools(discovered), system, maxSteps: 22 });
    const decision = extractJson(res.text);
    if (!decision) {
      store.log("warn", "Analyst reply wasn't valid JSON — no action this cycle.", res.text.slice(0, 400));
      return nothing();
    }
    return { decision, discovered: [...discovered.values()] };
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    store.log("error", `Analyst call failed: ${m.replace(/\s+/g, " ").slice(0, 220)}`);
    return nothing();
  }
}
