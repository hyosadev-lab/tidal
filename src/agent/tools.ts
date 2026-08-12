import type { Tool } from "./llm.ts";

/**
 * Template. Empty on purpose — nothing in this repo passes tools to `runAgent`.
 *
 * The analyst is one tool-less LLM call (`src/trading/analyst.ts`); that is the safety
 * barrier, not a preference. If you fill this file in, `askAnalyst` still must not take it
 * wholesale: name the read-only tools it may have, one by one, and never a shell or a route
 * that spends. Routes that spend refuse anyway unless `GMGN_ALLOW_AUTOMATED_TRADES=1` is in
 * the environment — that gate lives in `OpenApiClient.assertTradeConsent`, not here.
 *
 * Shape: `{description, parameters (JSON Schema), run}`. Spell every query param out with
 * `enum` where the API has a fixed set — the schema is the model's only description of the
 * route, and GMGN drops unknown keys silently, so a param it guesses looks like a call that
 * worked. `git log -- src/agent/tools.ts` has the full GMGN set as it used to be.
 */
export const tools: Record<string, Tool> = {
  // gmgn_token_info: {
  //   description: "Get a token's price, market cap, supply, and metadata.",
  //   parameters: {
  //     type: "object",
  //     properties: {
  //       chain: { type: "string", enum: ["sol", "bsc", "base", "eth"], description: "chain" },
  //       address: { type: "string", description: "token contract address" },
  //     },
  //     required: ["chain", "address"],
  //   },
  //   run: ({ chain, address }: { chain: string; address: string }) =>
  //     gmgnClient().getTokenInfo(chain, address),
  // },
};
