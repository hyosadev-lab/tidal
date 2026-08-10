import { runAgent, type Tool } from "../agent/llm.ts";
import { loadSkills, skillIndex, skillTool } from "../agent/skills.ts";
import { tools as allTools } from "../agent/tools.ts";
import { describeRule, pnlPct, systemPrompt, userPromptBlock } from "./plan.ts";
import { store } from "./store.ts";
import type { Candidate, Decision } from "./types.ts";

/**
 * The model half of a cycle: what the analyst is told, what it may look up, and what
 * comes back. `engine.ts` owns everything that spends money; nothing here does.
 *
 * Both the tools and the skills are now the shared ones — `src/agent/tools.ts` and the
 * top-level `skills/` — so there is one description of the GMGN surface instead of two
 * that drift. What the analyst may *do* with them is narrowed here, by allowlist.
 */
const skills = await loadSkills(new URL("../../skills", import.meta.url).pathname).catch(() => []);

/**
 * The analyst's tool set: read-only research, named one by one.
 *
 * An allowlist, not a filter over `allTools` — a tool added to `src/agent/tools.ts` is not in
 * the analyst's hands until someone writes its name here. That is the point: this loop runs
 * unattended every few minutes, on rows whose names and descriptions were written by whoever
 * deployed the contract, so the safe default when the shared tool set grows is "no".
 *
 * Deliberately absent: `bash` (a shell on the operator's machine), every route that spends or
 * commits to spending, and the operator's own wallet routes. Execution is the engine's job;
 * an analyst that cannot spend money cannot be talked into spending money by a token name.
 */
const ANALYST_TOOL_NAMES = [
  // feeds — context and the fields the cycle brief does not carry (sniper_count, bundler_rate)
  "gmgn_trending",
  "gmgn_trenches",
  "gmgn_token_signal",
  "gmgn_hot_searches",
  // one token, in depth
  "gmgn_token_info",
  "gmgn_token_security",
  "gmgn_token_pool_info",
  "gmgn_token_top_holders",
  "gmgn_token_top_traders",
  "gmgn_token_kline",
  // whose money is moving
  "gmgn_smart_money",
  "gmgn_kol",
  "gmgn_wallet_stats",
] as const;

const analystTools: Record<string, Tool> = {};
for (const name of ANALYST_TOOL_NAMES) {
  const tool = allTools[name];
  // Fail at import rather than run silently with a smaller tool set: a rename in
  // agent/tools.ts should break the build, not quietly remove a research step.
  if (!tool) throw new Error(`analyst tool "${name}" is missing from src/agent/tools.ts`);
  analystTools[name] = tool;
}
Object.assign(analystTools, skillTool(skills));

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

export async function askAnalyst(candidates: Candidate[], slots: number): Promise<Decision | null> {
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
    // The plan this one is actually running on — it was written for this token, and may
    // look nothing like the next row's.
    exit_plan: (p.strategy ?? []).map((r, i) => (p.filledRungs.includes(i) ? `[filled] ${describeRule(r)}` : describeRule(r))),
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
    // Research is per-token now rather than per-feed, so the ceiling is about how many
    // candidates get a second look. Raise it only if logs show the analyst running out.
    const res = await runAgent(prompt, { tools: analystTools, system, maxSteps: 22 });
    const decision = extractJson(res.text);
    if (!decision) {
      store.log("warn", "Analyst reply wasn't valid JSON — no action this cycle.", res.text.slice(0, 400));
      return null;
    }
    return decision;
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    store.log("error", `Analyst call failed: ${m.replace(/\s+/g, " ").slice(0, 220)}`);
    return null;
  }
}

export const _internals = { ANALYST_TOOL_NAMES, analystTools };
