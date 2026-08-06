import { exec } from "node:child_process";
import { promisify } from "node:util";
import { gmgnClient } from "../gmgn/client.ts";
import type { Tool } from "./llm.ts";

const execAsync = promisify(exec);

/**
 * GMGN tool schemas below cover every OpenApiClient endpoint (src/gmgn/endpoint.ts) — the
 * full GMGN OpenAPI surface, not just the read-only subset trading/engine.ts exposes to its
 * analyst. This file is consumed by src/cli.ts, the interactive human-in-the-loop chat, not
 * the headless trading engine — see CLAUDE.md's "analystTools ... read-only by design" note
 * for why the engine's tool set stays separate and narrower.
 *
 * Endpoints that spend real funds or commit to a future spend (swap, multi_swap,
 * strategy/create, cooking/create_token) still refuse at call time unless
 * GMGN_ALLOW_AUTOMATED_TRADES=1 is set — that gate lives in endpoint.ts itself
 * (OpenApiClient.assertTradeConsent), not here, so it can't be bypassed by adding a
 * different tool that calls the same client method.
 */

const chain = { type: "string", description: "sol | bsc | base | eth | robinhood | arc | stable" };
const address = { type: "string", description: "token contract address" };
const walletAddress = { type: "string", description: "wallet address" };
const extra = {
  type: "object",
  description: "Optional extra query params passed through as-is (e.g. limit, cursor, order_by).",
  additionalProperties: true,
};

function gmgnTool(description: string, properties: Record<string, unknown>, required: string[], run: (a: any) => Promise<unknown>): Tool {
  return { description, parameters: { type: "object", properties, required }, run };
}

export const tools: Record<string, Tool> = {
  bash: {
    description: "Run a shell command and return its stdout and stderr.",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
    run: async ({ command }: { command: string }) => {
      console.log(["  $", command].join(" "));
      try {
        const { stdout, stderr } = await execAsync(command, {
          timeout: 120_000,
          maxBuffer: 32 * 1024 * 1024,
        });
        return (stdout + (stderr ? `\n[stderr]\n${stderr}` : "")).slice(0, 120_000) || "(no output)";
      } catch (e: any) {
        return `exit ${e.code ?? "?"}: ${(e.stderr || e.stdout || e.message).slice(0, 4000)}`;
      }
    },
  },

  // ---- GMGN: Token ----

  gmgn_token_info: gmgnTool(
    "Get a token's price, market cap, supply, and metadata.",
    { chain, address },
    ["chain", "address"],
    ({ chain, address }) => gmgnClient().getTokenInfo(chain, address),
  ),

  gmgn_token_security: gmgnTool(
    "Get a token's security report: mint/freeze authority, LP burn/lock status, buy/sell tax, honeypot flag, top holder concentration.",
    { chain, address },
    ["chain", "address"],
    ({ chain, address }) => gmgnClient().getTokenSecurity(chain, address),
  ),

  gmgn_token_pool_info: gmgnTool(
    "Get a token's liquidity pool info (pool address, DEX, reserves, price).",
    { chain, address },
    ["chain", "address"],
    ({ chain, address }) => gmgnClient().getTokenPoolInfo(chain, address),
  ),

  gmgn_token_top_holders: gmgnTool(
    "Get a token's top holders by balance.",
    { chain, address, extra },
    ["chain", "address"],
    ({ chain, address, extra }) => gmgnClient().getTokenTopHolders(chain, address, extra ?? {}),
  ),

  gmgn_token_top_traders: gmgnTool(
    "Get a token's top traders by realized P&L.",
    { chain, address, extra },
    ["chain", "address"],
    ({ chain, address, extra }) => gmgnClient().getTokenTopTraders(chain, address, extra ?? {}),
  ),

  gmgn_token_kline: gmgnTool(
    "Get OHLCV candlestick history for a token.",
    {
      chain,
      address,
      resolution: { type: "string", description: "30s | 1m | 5m | 15m | 1h | 4h | 1d" },
      from: { type: "number", description: "Start time, Unix seconds (optional)" },
      to: { type: "number", description: "End time, Unix seconds (optional)" },
    },
    ["chain", "address", "resolution"],
    ({ chain, address, resolution, from, to }) =>
      gmgnClient().getTokenKline(chain, address, resolution, from != null ? from * 1000 : undefined, to != null ? to * 1000 : undefined),
  ),

  // ---- GMGN: Wallet / portfolio ----

  gmgn_wallet_holdings: gmgnTool(
    "Get a wallet's current token holdings. Signed route — requires GMGN_PRIVATE_KEY.",
    { chain, walletAddress, extra },
    ["chain", "walletAddress"],
    ({ chain, walletAddress, extra }) => gmgnClient().getWalletHoldings(chain, walletAddress, extra ?? {}),
  ),

  gmgn_wallet_activity: gmgnTool(
    "Get a wallet's recent trade activity.",
    { chain, walletAddress, extra },
    ["chain", "walletAddress"],
    ({ chain, walletAddress, extra }) => gmgnClient().getWalletActivity(chain, walletAddress, extra ?? {}),
  ),

  gmgn_wallet_stats: gmgnTool(
    "Get win rate, P&L, and trading stats for one or more wallets.",
    {
      chain,
      walletAddresses: { type: "array", items: { type: "string" }, description: "one or more wallet addresses" },
      period: { type: "string", description: "e.g. 7d, 30d (default 7d)" },
    },
    ["chain", "walletAddresses"],
    ({ chain, walletAddresses, period }) => gmgnClient().getWalletStats(chain, walletAddresses, period ?? "7d"),
  ),

  gmgn_wallet_token_balance: gmgnTool(
    "Get one wallet's balance of one specific token.",
    { chain, walletAddress, tokenAddress: address },
    ["chain", "walletAddress", "tokenAddress"],
    ({ chain, walletAddress, tokenAddress }) => gmgnClient().getWalletTokenBalance(chain, walletAddress, tokenAddress),
  ),

  gmgn_created_tokens: gmgnTool(
    "List tokens a wallet has created/launched.",
    { chain, walletAddress, extra },
    ["chain", "walletAddress"],
    ({ chain, walletAddress, extra }) => gmgnClient().getCreatedTokens(chain, walletAddress, extra ?? {}),
  ),

  // ---- GMGN: Market discovery ----

  gmgn_trenches: gmgnTool(
    "Browse launchpad tokens: new_creation, near_completion, or completed (graduated).",
    {
      chain,
      types: { type: "array", items: { type: "string" }, description: "subset of new_creation | near_completion | completed" },
      platforms: { type: "array", items: { type: "string" }, description: "launchpad platform allow-list; omit for the chain default" },
      limit: { type: "number" },
      filters: { type: "object", additionalProperties: true, description: "e.g. max_rug_ratio, min_volume_24h" },
    },
    ["chain"],
    ({ chain, types, platforms, limit, filters }) => gmgnClient().getTrenches(chain, types, platforms, limit, filters),
  ),

  gmgn_trending: gmgnTool(
    "Get trending/top tokens ranked by volume, price change, etc.",
    { chain, interval: { type: "string", description: "e.g. 1m, 5m, 1h, 6h, 24h" }, extra },
    ["chain", "interval"],
    ({ chain, interval, extra }) => gmgnClient().getTrendingSwaps(chain, interval, extra ?? {}),
  ),

  gmgn_token_signal: gmgnTool(
    "Get tokens matching signal criteria (e.g. smart-money buys, price spikes, ATH) grouped by filter.",
    {
      chain,
      groups: {
        type: "array",
        description: "TokenSignalGroup[] — signal_type (12=smart money buy, 6=price spike, 7=ATH) plus optional mc/fee/timestamp bounds",
        items: { type: "object", additionalProperties: true },
      },
    },
    ["chain", "groups"],
    ({ chain, groups }) => gmgnClient().getTokenSignalV2(chain, groups),
  ),

  gmgn_hot_searches: gmgnTool(
    "Get the most-searched tokens on GMGN — a crowd-attention feed, not a quality signal.",
    {
      params: {
        type: "array",
        description: "HotSearchesParam[] — each needs chain + interval, plus optional filters/limit/min_*/max_* bounds",
        items: { type: "object", additionalProperties: true },
      },
    },
    ["params"],
    ({ params }) => gmgnClient().getHotSearches(params),
  ),

  // ---- GMGN: User / social ----

  gmgn_user_info: gmgnTool("Get the API key's own account info and bound wallets.", {}, [], () => gmgnClient().getUserInfo()),

  gmgn_follow_wallet: gmgnTool(
    "Get trade activity from wallets the account follows. Signed route — requires GMGN_PRIVATE_KEY.",
    { chain, extra },
    ["chain"],
    ({ chain, extra }) => gmgnClient().getFollowWallet(chain, extra ?? {}),
  ),

  gmgn_follow_tokens: gmgnTool(
    "Get a wallet's followed/watchlisted tokens.",
    { chain, walletAddress, extra },
    ["chain", "walletAddress"],
    ({ chain, walletAddress, extra }) => gmgnClient().getFollowTokens(chain, walletAddress, extra ?? {}),
  ),

  gmgn_follow_group_names: gmgnTool(
    "Get a wallet's follow-list group names.",
    { chain, walletAddress },
    ["chain", "walletAddress"],
    ({ chain, walletAddress }) => gmgnClient().getFollowGroupNames(chain, walletAddress),
  ),

  gmgn_kol: gmgnTool(
    "Get the KOL (key opinion leader) wallet list.",
    { chain: { ...chain, description: chain.description + " (optional)" }, limit: { type: "number" } },
    [],
    ({ chain, limit }) => gmgnClient().getKol(chain, limit),
  ),

  gmgn_smart_money: gmgnTool(
    "Get the smart-money wallet list.",
    { chain: { ...chain, description: chain.description + " (optional)" }, limit: { type: "number" } },
    [],
    ({ chain, limit }) => gmgnClient().getSmartMoney(chain, limit),
  ),

  // ---- GMGN: Trade (reads) ----

  gmgn_quote: gmgnTool(
    "Get a swap quote (expected output amount, price impact) without executing anything.",
    {
      chain,
      fromAddress: { type: "string", description: "the wallet that would send the swap" },
      inputToken: address,
      outputToken: { type: "string", description: "output token contract address" },
      inputAmount: { type: "string", description: "smallest-unit input amount" },
      slippage: { type: "number", description: "percent, e.g. 1 for 1%" },
    },
    ["chain", "fromAddress", "inputToken", "outputToken", "inputAmount", "slippage"],
    ({ chain, fromAddress, inputToken, outputToken, inputAmount, slippage }) =>
      gmgnClient().quoteOrder(chain, fromAddress, inputToken, outputToken, inputAmount, slippage),
  ),

  gmgn_gas_price: gmgnTool("Get the current native-token gas price and USD price for a chain.", { chain }, ["chain"], ({ chain }) =>
    gmgnClient().getGasPrice(chain),
  ),

  gmgn_query_order: gmgnTool(
    "Check the status of a previously submitted swap order. Signed route — requires GMGN_PRIVATE_KEY.",
    { orderId: { type: "string" }, chain },
    ["orderId", "chain"],
    ({ orderId, chain }) => gmgnClient().queryOrder(orderId, chain),
  ),

  gmgn_strategy_orders: gmgnTool(
    "List open strategy (conditional take-profit/stop-loss) orders. Signed route — requires GMGN_PRIVATE_KEY.",
    { chain, extra },
    ["chain"],
    ({ chain, extra }) => gmgnClient().getStrategyOrders(chain, extra ?? {}),
  ),

  gmgn_cooking_statistics: gmgnTool("Get platform-wide token-launch (\"cooking\") statistics.", {}, [], () =>
    gmgnClient().getCookingStatistics(),
  ),

  // ---- GMGN: Trade (spends real funds — refuses unless GMGN_ALLOW_AUTOMATED_TRADES=1) ----

  gmgn_swap: gmgnTool(
    "Execute a real, irreversible on-chain swap. Refuses unless the operator set GMGN_ALLOW_AUTOMATED_TRADES=1 in this shell.",
    { params: { type: "object", additionalProperties: true, description: "SwapParams — chain, from_address, input_token, output_token, input_amount, slippage, plus optional fee/anti-mev/condition_orders fields" } },
    ["params"],
    ({ params }) => gmgnClient().swap(params),
  ),

  gmgn_multi_swap: gmgnTool(
    "Execute the same swap across multiple wallets at once. Refuses unless GMGN_ALLOW_AUTOMATED_TRADES=1 is set.",
    { params: { type: "object", additionalProperties: true, description: "MultiSwapParams — chain, accounts[], input_token, output_token, plus amount/fee fields" } },
    ["params"],
    ({ params }) => gmgnClient().multiSwap(params),
  ),

  gmgn_strategy_create: gmgnTool(
    "Create a conditional strategy order (e.g. take-profit / stop-loss that fires automatically). Commits future spend — refuses unless GMGN_ALLOW_AUTOMATED_TRADES=1 is set.",
    { params: { type: "object", additionalProperties: true, description: "StrategyCreateParams — chain, from_address, base_token, quote_token, order_type, sub_order_type, plus trigger/sizing fields" } },
    ["params"],
    ({ params }) => gmgnClient().createStrategyOrder(params),
  ),

  gmgn_strategy_cancel: gmgnTool(
    "Cancel an open strategy order. Signed route — requires GMGN_PRIVATE_KEY. Safe: this only removes a pending order, never spends.",
    { params: { type: "object", additionalProperties: true, description: "StrategyCancelParams — chain, from_address, order_id, plus optional order_type/close_sell_model" } },
    ["params"],
    ({ params }) => gmgnClient().cancelStrategyOrder(params),
  ),

  gmgn_create_token: gmgnTool(
    "Launch a new token on a launchpad and execute the creator's initial buy. Spends real funds — refuses unless GMGN_ALLOW_AUTOMATED_TRADES=1 is set.",
    { params: { type: "object", additionalProperties: true, description: "CreateTokenParams — chain, dex, from_address, name, symbol, buy_amt, image/image_url, plus many optional fields" } },
    ["params"],
    ({ params }) => gmgnClient().createToken(params),
  ),
};
