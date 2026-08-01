import { execFile } from "node:child_process";
import type { Chain } from "./types.ts";

/**
 * Thin wrapper over `gmgn-cli`. Every call goes through a shared leaky bucket
 * (rate 20, capacity 20, per-route weights) because GMGN extends the cooldown by
 * 5s each time you hit a 429 — spamming retries makes the ban worse, not better.
 */

const RATE = 20;
const CAPACITY = 20;
let tokens = CAPACITY;
let lastRefill = Date.now();
let queue: Promise<unknown> = Promise.resolve();

async function takeTokens(weight: number): Promise<void> {
  for (;;) {
    const now = Date.now();
    tokens = Math.min(CAPACITY, tokens + ((now - lastRefill) / 1000) * RATE);
    lastRefill = now;
    if (tokens >= weight) {
      tokens -= weight;
      return;
    }
    await new Promise((r) => setTimeout(r, Math.ceil(((weight - tokens) / RATE) * 1000) + 20));
  }
}

export class GmgnError extends Error {
  code: number;
  resetAt: number;
  constructor(message: string, code = 0, resetAt = 0) {
    super(message);
    this.name = "GmgnError";
    this.code = code;
    this.resetAt = resetAt;
  }
}

function exec(args: string[], timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "gmgn-cli",
      args,
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, ...env } },
      (err, stdout, stderr) => {
        if (err) {
          const text = `${stderr || ""}${stdout || ""}`.trim();
          if (/ENOENT/.test(String(err)))
            return reject(new GmgnError("gmgn-cli not found — run: npm install -g gmgn-cli"));
          const reset = /"?reset_at"?\s*:\s*(\d+)/.exec(text);
          const is429 = /429|RATE_LIMIT/.test(text);
          return reject(
            new GmgnError(text.slice(0, 1200) || String(err), is429 ? 429 : 1, reset ? Number(reset[1]) : 0),
          );
        }
        resolve(stdout);
      },
    );
  });
}

/** Serialised so the bucket accounting stays honest under concurrency. */
async function cli<T = any>(args: string[], weight = 1, timeoutMs = 60_000, env?: NodeJS.ProcessEnv): Promise<T> {
  const run = async (): Promise<T> => {
    await takeTokens(weight);
    const out = await exec([...args, "--raw"], timeoutMs, env);
    const text = out.trim();
    if (!text) return {} as T;
    try {
      const parsed = JSON.parse(text);
      return (parsed && typeof parsed === "object" && "data" in parsed ? (parsed as any).data : parsed) as T;
    } catch {
      // some subcommands print a human line before the JSON payload
      const brace = Math.min(...[text.indexOf("{"), text.indexOf("[")].filter((i) => i >= 0));
      if (Number.isFinite(brace) && brace >= 0) {
        try {
          const parsed = JSON.parse(text.slice(brace));
          return (parsed && typeof parsed === "object" && "data" in parsed ? (parsed as any).data : parsed) as T;
        } catch {
          /* fall through */
        }
      }
      throw new GmgnError(`could not parse gmgn-cli output: ${text.slice(0, 300)}`);
    }
  };
  const result = queue.then(run, run);
  queue = result.catch(() => undefined);
  return result;
}

export const num = (v: unknown, d = 0): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : d;
};

const list = (r: any, ...keys: string[]): any[] => {
  if (Array.isArray(r)) return r;
  for (const k of keys) if (Array.isArray(r?.[k])) return r[k];
  for (const k of keys) if (Array.isArray(r?.data?.[k])) return r.data[k];
  return [];
};

// ── read-only routes ──────────────────────────────────────────────────

export async function configOk(): Promise<boolean> {
  try {
    await exec(["config", "--check"], 20_000);
    return true;
  } catch {
    return false;
  }
}

export type RankItem = Record<string, any>;

export async function trending(
  chain: Chain,
  opts: {
    interval?: string;
    limit?: number;
    minLiquidity?: number;
    minVolume?: number;
    maxRugRatio?: number;
    minSmartDegen?: number;
    maxCreated?: string;
  } = {},
): Promise<RankItem[]> {
  const a = ["market", "trending", "--chain", chain, "--interval", opts.interval ?? "1h", "--order-by", "volume"];
  a.push("--limit", String(opts.limit ?? 50));
  if (opts.minLiquidity) a.push("--min-liquidity", String(Math.round(opts.minLiquidity)));
  if (opts.minVolume) a.push("--min-volume", String(Math.round(opts.minVolume)));
  if (opts.minSmartDegen) a.push("--min-smart-degen-count", String(opts.minSmartDegen));
  if (opts.maxCreated) a.push("--max-created", opts.maxCreated);
  return list(await cli(a, 1), "rank");
}

export async function trenches(chain: Chain, type = "completed", limit = 40): Promise<RankItem[]> {
  const r = await cli(
    ["market", "trenches", "--chain", chain, "--type", type, "--filter-preset", "strict", "--limit", String(limit)],
    3,
  );
  return [...list(r, "completed"), ...list(r, "pump"), ...list(r, "new_creation")];
}

export async function signals(chain: Chain): Promise<RankItem[]> {
  // 12 = smart money buy, 6 = price spike, 7 = ATH
  const r = await cli(["market", "signal", "--chain", chain, "--groups", '[{"signal_type":[12]},{"signal_type":[6,7]}]'], 3);
  return list(r, "list", "signals");
}

export async function tokenInfo(chain: Chain, address: string): Promise<Record<string, any>> {
  return cli(["token", "info", "--chain", chain, "--address", address], 1, 40_000);
}

export async function tokenSecurity(chain: Chain, address: string): Promise<Record<string, any>> {
  return cli(["token", "security", "--chain", chain, "--address", address], 1, 40_000);
}

export async function tokenHolders(chain: Chain, address: string, limit = 20, tag?: string): Promise<any[]> {
  const a = ["token", "holders", "--chain", chain, "--address", address, "--limit", String(limit)];
  if (tag) a.push("--tag", tag);
  return list(await cli(a, 5), "list");
}

export async function kline(chain: Chain, address: string, resolution: string, fromSec: number, toSec: number) {
  return list(
    await cli(
      [
        "market",
        "kline",
        "--chain",
        chain,
        "--address",
        address,
        "--resolution",
        resolution,
        "--from",
        String(Math.floor(fromSec)),
        "--to",
        String(Math.floor(toSec)),
      ],
      2,
    ),
    "list",
  );
}

export async function smartMoney(chain: Chain, limit = 60): Promise<any[]> {
  return list(await cli(["track", "smartmoney", "--chain", chain, "--limit", String(limit)], 1), "list");
}

export async function nativeUsdPrice(chain: Chain): Promise<number> {
  const r = await cli(["gas-price", "--chain", chain], 1, 30_000);
  return num(r?.native_token_usd_price ?? r?.nativeTokenUsdPrice);
}

/**
 * Native balance of the API-key-bound wallet, in whole units (SOL / BNB / ETH).
 *
 * The gmgn-portfolio skill documents that `portfolio info` returns "wallets and main
 * currency balances" but not the field names, so this walks the response looking for
 * the matching wallet and a balance-shaped number. Returns null rather than a guess —
 * sizing a real trade off an invented balance is worse than not trading.
 */
export async function nativeBalance(chain: Chain, wallet: string): Promise<number | null> {
  const r = await cli(["portfolio", "info"], 1, 40_000);
  const target = wallet.trim().toLowerCase();

  const balanceOf = (o: Record<string, any>): number | null => {
    for (const k of ["balance", "native_balance", "sol_balance", "amount", "available_balance"]) {
      const v = num(o[k], -1);
      if (v >= 0) return v;
    }
    return null;
  };

  const walk = (node: unknown, depth = 0): number | null => {
    if (depth > 5 || !node || typeof node !== "object") return null;
    if (Array.isArray(node)) {
      for (const item of node) {
        const hit = walk(item, depth + 1);
        if (hit !== null) return hit;
      }
      return null;
    }
    const o = node as Record<string, any>;
    const addr = String(o.address ?? o.wallet ?? o.wallet_address ?? "").toLowerCase();
    const nodeChain = String(o.chain ?? "").toLowerCase();
    if (addr === target && (!nodeChain || nodeChain === chain)) {
      const b = balanceOf(o);
      if (b !== null) return b;
    }
    for (const v of Object.values(o)) {
      const hit = walk(v, depth + 1);
      if (hit !== null) return hit;
    }
    return null;
  };

  return walk(r);
}

/** Live price for a held position. Falls back to the pool price if info is thin. */
export async function currentPrice(chain: Chain, address: string): Promise<number> {
  const info = await tokenInfo(chain, address);
  const p = num(info?.price?.price ?? info?.price);
  if (p > 0) return p;
  const pool = await cli<Record<string, any>>(["token", "pool", "--chain", chain, "--address", address], 1, 30_000);
  return num(pool?.price ?? pool?.[0]?.price);
}

// ── execution routes ──────────────────────────────────────────────────

export type SwapResult = {
  order_id?: string;
  hash?: string;
  status?: string;
  error_code?: string;
  error_status?: string;
  strategy_order_id?: string;
  report?: Record<string, any>;
};

export type SwapArgs = {
  chain: Chain;
  from: string;
  inputToken: string;
  outputToken: string;
  /** Smallest-unit amount. Mutually exclusive with percent. */
  amount?: string;
  /** Percent of balance — only valid when the input token is NOT a currency. */
  percent?: number;
  slippage: number;
  antiMev?: boolean;
  conditionOrders?: unknown[];
  sellRatioType?: "buy_amount" | "hold_amount";
};

export async function quote(a: Omit<SwapArgs, "conditionOrders" | "sellRatioType">): Promise<Record<string, any>> {
  const args = [
    "order",
    "quote",
    "--chain",
    a.chain,
    "--from",
    a.from,
    "--input-token",
    a.inputToken,
    "--output-token",
    a.outputToken,
    "--slippage",
    String(a.slippage),
  ];
  if (a.amount) args.push("--amount", a.amount);
  return cli(args, 2, 45_000);
}

/**
 * Submits a real, irreversible on-chain swap.
 *
 * `--yes` is passed, but the CLI rejects it unless GMGN_ALLOW_AUTOMATED_TRADES=1 is
 * already present in the operator's own environment. We deliberately do not inject
 * that variable: it is the human's standing consent to headless execution, and this
 * process is not entitled to grant it on their behalf.
 */
export async function swap(a: SwapArgs): Promise<SwapResult> {
  if (process.env.GMGN_ALLOW_AUTOMATED_TRADES !== "1")
    throw new GmgnError("live trade refused: GMGN_ALLOW_AUTOMATED_TRADES=1 is not set in this shell");

  const args = [
    "swap",
    "--chain",
    a.chain,
    "--from",
    a.from,
    "--input-token",
    a.inputToken,
    "--output-token",
    a.outputToken,
    "--slippage",
    String(a.slippage),
  ];
  if (a.amount) args.push("--amount", a.amount);
  else if (a.percent) args.push("--percent", String(a.percent));
  if (a.antiMev && a.chain !== "base") args.push("--anti-mev");
  if (a.conditionOrders?.length) {
    args.push("--condition-orders", JSON.stringify(a.conditionOrders));
    args.push("--sell-ratio-type", a.sellRatioType ?? "hold_amount");
  }
  args.push("--yes");
  return cli<SwapResult>(args, 5, 120_000);
}

export async function orderStatus(chain: Chain, orderId: string): Promise<SwapResult> {
  return cli<SwapResult>(["order", "get", "--chain", chain, "--order-id", orderId], 1, 30_000);
}

/** Polls until the order settles; GMGN moves pending → processed → confirmed. */
export async function waitForOrder(chain: Chain, orderId: string, tries = 6): Promise<SwapResult> {
  let last: SwapResult = {};
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    try {
      last = await orderStatus(chain, orderId);
      const s = (last.status ?? "").toLowerCase();
      if (["confirmed", "successful", "failed", "expired"].includes(s)) return last;
    } catch {
      /* keep polling; a transient read failure is not a failed trade */
    }
  }
  return last;
}
