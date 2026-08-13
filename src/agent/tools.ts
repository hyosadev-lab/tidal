import type { Tool } from "./llm.ts";
import type { Chain } from "../trading/types.ts";
import { tokenInfo, kline } from "../trading/market.ts";

/**
 * The analyst's tools: two read-only GMGN routes, for deep-diving a candidate that is already
 * in the cycle brief. `askAnalyst` takes them through `budgetedTools` — everything here is
 * paid out of the same process-wide rate limit the candidate sweep runs on.
 *
 * What must not appear in this record: a shell, a filesystem, or any route that spends. Spend
 * routes refuse anyway unless `GMGN_ALLOW_AUTOMATED_TRADES=1` is in the environment (that gate
 * is `OpenApiClient.assertTradeConsent`), but the reason there is nothing to reach them with
 * is this file. Add read routes one named tool at a time.
 *
 * Shape: `{description, parameters (JSON Schema), run}`. Spell every query param out with
 * `enum` where the API has a fixed set — the schema is the model's only description of the
 * route, and GMGN drops unknown keys silently, so a param it guesses looks like a call that
 * worked. `git log -- src/agent/tools.ts` has the full GMGN set as it used to be.
 */
/**
 * Per-cycle lookup budget. GMGN's limiter is process-wide (~20 weight per 30s, IP-scoped) and
 * the sweep has already spent most of it by the time the analyst runs, so the model gets a
 * small allowance and a plain refusal after it — not an error, so it just answers from the brief.
 */
export function budgetedTools(max = 6): Record<string, Tool> {
  let left = max;
  return Object.fromEntries(
    Object.entries(tools).map(([name, t]) => [
      name,
      { ...t, run: (a: any) => (left-- > 0 ? t.run(a) : `lookup budget spent (${max} per cycle) — decide on the brief.`) },
    ]),
  );
}

const CHAIN = { type: "string", enum: ["sol", "bsc", "base", "eth"], description: "chain" } as const;
const ADDRESS = { type: "string", description: "token contract address" } as const;

export const tools: Record<string, Tool> = {
  gmgn_token_info: {
    description: "Get a token's price, market cap, supply, and metadata.",
    parameters: {
      type: "object",
      properties: { chain: CHAIN, address: ADDRESS },
      required: ["chain", "address"],
    },
    run: ({ chain, address }: { chain: Chain; address: string }) => tokenInfo(chain, address),
  },

  gmgn_token_kline: {
    description:
      "Get OHLCV candles for a token. Defaults to the last `limit` candles ending now; " +
      "each candle costs no extra call, but the whole request is paid out of the sweep's rate limit.",
    parameters: {
      type: "object",
      properties: {
        chain: CHAIN,
        address: ADDRESS,
        resolution: {
          type: "string",
          enum: ["1s", "1m", "5m", "15m", "1h", "4h", "1d"],
          description: "candle size",
        },
        limit: { type: "integer", description: "how many candles back from now (default 60, max 300)" },
      },
      required: ["chain", "address", "resolution"],
    },
    run: ({ chain, address, resolution, limit }: { chain: Chain; address: string; resolution: string; limit?: number }) => {
      const secs: Record<string, number> = { "1s": 1, "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
      const n = Math.min(Math.max(limit ?? 60, 1), 300);
      const to = Date.now() / 1000;
      return kline(chain, address, resolution, to - n * (secs[resolution] ?? 60), to);
    },
  },
};
