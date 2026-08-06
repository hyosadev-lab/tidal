import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Chain, Mode, TradeConfig } from "./types.ts";

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const DATA_DIR = join(ROOT, "data");

export const CHAINS: Chain[] = ["sol", "bsc", "base", "eth"];

/** Native currency address + decimals per chain — copied from the gmgn-swap skill table. */
export const NATIVE: Record<Chain, { symbol: string; address: string; decimals: number }> = {
  sol: { symbol: "SOL", address: "So11111111111111111111111111111111111111112", decimals: 9 },
  bsc: { symbol: "BNB", address: "0x0000000000000000000000000000000000000000", decimals: 18 },
  base: { symbol: "ETH", address: "0x0000000000000000000000000000000000000000", decimals: 18 },
  eth: { symbol: "ETH", address: "0x0000000000000000000000000000000000000000", decimals: 18 },
};

/**
 * Smallest position worth opening per chain. Driven by round-trip friction:
 * SOL gas is fractions of a cent, ETH mainnet gas is not.
 */
export const MIN_POSITION_USD: Record<Chain, number> = { sol: 3, bsc: 5, base: 5, eth: 25 };

/** Native units kept aside for gas. Without this, a full deployment cannot pay to exit. */
export const GAS_RESERVE: Record<Chain, number> = { sol: 0.02, bsc: 0.004, base: 0.0015, eth: 0.004 };

export const EXPLORER: Record<Chain, string> = {
  sol: "https://solscan.io/tx/",
  bsc: "https://bscscan.com/tx/",
  base: "https://basescan.org/tx/",
  eth: "https://etherscan.io/tx/",
};

/**
 * GMGN's 🔴 Skip column, transcribed from the "Pass / Watch / Skip Criteria" table in
 * `skills/gmgn-market/SKILL.md`. Not in `TradeConfig` and not on the dashboard: these are the
 * published thresholds for what is disqualified, so there is nothing here for an operator to
 * tune — a different number would just be an invented one wearing the table's name.
 *
 * They are a floor, not a strategy. Everything above them still has to earn its place through
 * `score()` and the analyst. To trade something tighter, say so in the dashboard prompt.
 */
export const SKIP = {
  minLiquidityUsd: 10_000,
  maxRugRatio: 0.3,
  maxTop10HolderRate: 0.5,
  minSmartDegenCount: 1,
} as const;

export const DEFAULT_CONFIG: TradeConfig = {
  chain: "sol",
  mode: "paper",
  intervalMinutes: 15,
  monitorSeconds: 30,
  prompt: "",

  riskPerTradePct: 4,
  maxOpenPositions: 5,
  maxDailyLossPct: 15,
  stopLossPct: 25,
  takeProfit: [
    { at: 60, sell: 40 },
    { at: 150, sell: 30 },
    { at: 400, sell: 20 },
  ],
  trailArmPct: 45,
  trailGivebackPct: 25,
  timeStopMinutes: 180,
  timeStopMinPnlPct: 8,
  cooldownMinutes: 120,

  // Not a gate — pushed to the GMGN feeds as a query filter, so it shapes what gets fetched.
  minVolume1hUsd: 20_000,
  slippagePct: 20,

  minPositionUsd: 0,
  gasReserveNative: 0,
  paperStartEquityUsd: 1000,
  walletAddress: "",
};

export const minPosition = (cfg: TradeConfig): number => cfg.minPositionUsd || MIN_POSITION_USD[cfg.chain];
export const gasReserve = (cfg: TradeConfig): number => cfg.gasReserveNative || GAS_RESERVE[cfg.chain];

const CONFIG_PATH = join(DATA_DIR, "config.json");

function clamp(n: unknown, lo: number, hi: number, fallback: number): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Coerce whatever arrived from the dashboard into a config we're willing to trade with.
 * Every bound here is a real safety limit, not input tidying.
 */
export function sanitizeConfig(input: Partial<TradeConfig>, base: TradeConfig = DEFAULT_CONFIG): TradeConfig {
  const chain = CHAINS.includes(input.chain as Chain) ? (input.chain as Chain) : base.chain;
  const mode: Mode = input.mode === "live" ? "live" : input.mode === "paper" ? "paper" : base.mode;

  let ladder = Array.isArray(input.takeProfit) ? input.takeProfit : base.takeProfit;
  ladder = ladder
    .map((r) => ({ at: clamp(r?.at, 5, 5000, 60), sell: clamp(r?.sell, 1, 100, 30) }))
    .sort((a, b) => a.at - b.at)
    .slice(0, 5);
  if (!ladder.length) ladder = base.takeProfit;

  return {
    chain,
    mode,
    intervalMinutes: clamp(input.intervalMinutes, 1, 1440, base.intervalMinutes),
    monitorSeconds: clamp(input.monitorSeconds, 10, 600, base.monitorSeconds),
    prompt: typeof input.prompt === "string" ? input.prompt.slice(0, 8000) : base.prompt,

    riskPerTradePct: clamp(input.riskPerTradePct, 0.5, 25, base.riskPerTradePct),
    maxOpenPositions: Math.round(clamp(input.maxOpenPositions, 1, 20, base.maxOpenPositions)),
    maxDailyLossPct: clamp(input.maxDailyLossPct, 1, 90, base.maxDailyLossPct),
    stopLossPct: clamp(input.stopLossPct, 5, 90, base.stopLossPct),
    takeProfit: ladder,
    trailArmPct: clamp(input.trailArmPct, 5, 1000, base.trailArmPct),
    trailGivebackPct: clamp(input.trailGivebackPct, 5, 80, base.trailGivebackPct),
    timeStopMinutes: clamp(input.timeStopMinutes, 5, 10080, base.timeStopMinutes),
    timeStopMinPnlPct: clamp(input.timeStopMinPnlPct, -50, 500, base.timeStopMinPnlPct),
    cooldownMinutes: clamp(input.cooldownMinutes, 0, 10080, base.cooldownMinutes),

    // The gate thresholds are not here — see SKIP. This one only narrows the feed query.
    minVolume1hUsd: clamp(input.minVolume1hUsd, 0, 100_000_000, base.minVolume1hUsd),
    slippagePct: Math.round(clamp(input.slippagePct, 1, 100, base.slippagePct)),

    minPositionUsd: clamp(input.minPositionUsd, 0, 100_000, base.minPositionUsd),
    gasReserveNative: clamp(input.gasReserveNative, 0, 10, base.gasReserveNative),
    paperStartEquityUsd: clamp(input.paperStartEquityUsd, 10, 10_000_000, base.paperStartEquityUsd),
    walletAddress: typeof input.walletAddress === "string" ? input.walletAddress.trim().slice(0, 80) : base.walletAddress,
  };
}

export function loadConfig(): TradeConfig {
  try {
    return sanitizeConfig(JSON.parse(readFileSync(CONFIG_PATH, "utf8")));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(cfg: TradeConfig): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

/**
 * Live trading needs an explicit opt-in the operator sets in their own shell.
 * We never set GMGN_ALLOW_AUTOMATED_TRADES ourselves — that variable is the human's
 * consent to headless execution, so setting it from here would hollow out the barrier
 * it exists to provide. Since this process signs its own trade requests, this check is
 * the whole barrier; there is no second process left to refuse on our behalf.
 */
export function liveReady(cfg: TradeConfig): { ok: boolean; reason: string } {
  if (process.env.GMGN_ALLOW_AUTOMATED_TRADES !== "1")
    return { ok: false, reason: "GMGN_ALLOW_AUTOMATED_TRADES=1 is not set in this shell" };
  if (!process.env.GMGN_API_KEY?.trim()) return { ok: false, reason: "GMGN_API_KEY is not set" };
  if (!process.env.GMGN_PRIVATE_KEY?.trim())
    return { ok: false, reason: "GMGN_PRIVATE_KEY is not set — trade requests cannot be signed" };
  if (!cfg.walletAddress) return { ok: false, reason: "no wallet address configured" };
  return { ok: true, reason: "" };
}
