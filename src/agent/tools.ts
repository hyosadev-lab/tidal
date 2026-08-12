import { exec } from "node:child_process";
import { promisify } from "node:util";
import { gmgnClient } from "../gmgn/client.ts";
import type { Tool } from "./llm.ts";

const execAsync = promisify(exec);

/**
 * GMGN tool schemas below cover the OpenApiClient endpoints (src/gmgn/endpoint.ts) — the GMGN
 * OpenAPI surface, shared by both consumers:
 *
 *   • src/cli.ts takes the whole object, `bash` included: interactive, human at the prompt.
 *   • src/trading/analyst.ts takes a named read-only subset (`ANALYST_TOOL_NAMES`) — an
 *     allowlist, so anything added here stays out of the unattended trading loop until
 *     someone names it there. Never widen that list to `bash` or a route that spends.
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
// Every optional query param is spelled out below rather than hidden behind a passthrough
// `extra` object. The schema is the model's only description of a tool — a key it cannot see is
// a key it cannot send, and GMGN ignores unknown params silently, so a guess reads as a
// successful call that quietly returned the default ordering. Values come from the vendored
// `skills/gmgn-*` docs; the enums are the accepted values, not suggestions.
const limitOf = (max: number, def: number) => ({ type: "number", description: `results, max ${max} (default ${def})` });
const cursor = { type: "string", description: "pagination cursor — the `next` value from the previous response" };
const direction = { type: "string", enum: ["asc", "desc"], description: "sort direction (default desc)" };
const oneOf = (values: string[], description: string) => ({ type: "string", enum: values, description });
const manyOf = (values: string[], description: string) => ({ type: "array", items: { type: "string", enum: values }, description });
const flag = (description: string) => ({ type: "boolean", description });

/** `min_<field>` / `max_<field>` pairs as real properties, so the whole filter surface is visible. */
function bounds(fields: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, what] of Object.entries(fields)) {
    out[`min_${field}`] = { type: "number", description: `minimum ${what}` };
    out[`max_${field}`] = { type: "number", description: `maximum ${what}` };
  }
  return out;
}

function gmgnTool(description: string, properties: Record<string, unknown>, required: string[], run: (a: any) => Promise<unknown>): Tool {
  return { description, parameters: { type: "object", properties, required }, run };
}

/** Range filters the rank feed accepts — `gmgn_hot_searches` here, and `gmgn_trending` if it is
 *  ever uncommented. The engine's own sweep sends the same keys via `refineQuery` (config.ts). */
const RANK_BOUNDS = {
  volume: "trading volume over the interval (USD)",
  liquidity: "liquidity (USD)",
  marketcap: "market cap (USD)",
  history_highest_marketcap: "all-time highest market cap (USD)",
  swaps: "swap count",
  holder_count: "holder count",
  gas_fee: "gas fee",
  renowned_count: "KOL wallet count",
  smart_degen_count: "smart-money holder count",
  bot_degen_count: "bot-degen wallet count",
  visiting_count: "visitor count",
  price_change_percent: "price change over the interval, as a ratio",
  insider_rate: "insider trading ratio (0–1); tokens missing this field are excluded",
  bundler_rate: "bundle-bot trading ratio (0–1); tokens missing this field are excluded",
  entrapment_ratio: "entrapment trading ratio (0–1); tokens missing this field are excluded",
  top10_holder_rate: "top-10 holder concentration (0–1)",
  top70_sniper_hold_rate: "top-70 sniper holding ratio (0–1)",
  dev_team_hold_rate: "dev-team holding ratio (0–1); the min side also excludes creator-close tokens",
};

/** Range filters the launchpad feed accepts. Same idea, different field names — `top_holder_rate`
 *  here is `top10_holder_rate` on the rank feed, and the creator fields have no rank equivalent.
 *  Commented out with `gmgn_trenches` below; uncomment both together. */
// const TRENCHES_BOUNDS = {
//   volume_24h: "24h trading volume (USD)",
//   net_buy_24h: "24h net buy volume (USD)",
//   swaps_24h: "24h swap count",
//   buys_24h: "24h buy count",
//   sells_24h: "24h sell count",
//   visiting_count: "visitor count",
//   progress: "bonding curve progress (0–1)",
//   marketcap: "market cap (USD)",
//   liquidity: "liquidity (USD)",
//   holder_count: "holder count",
//   top_holder_rate: "top-10 holder concentration (0–1)",
//   rug_ratio: "rug-pull risk score (0–1)",
//   bundler_rate: "bundle-bot trading ratio (0–1)",
//   insider_ratio: "insider trading ratio (0–1)",
//   entrapment_ratio: "entrapment/phishing trading ratio (0–1)",
//   private_vault_hold_rate: "private vault holding ratio (0–1)",
//   top70_sniper_hold_rate: "top-70 sniper holding ratio (0–1)",
//   bot_count: "bot wallet count",
//   bot_degen_rate: "bot-degen wallet ratio (0–1)",
//   fresh_wallet_rate: "fresh wallet ratio (0–1)",
//   total_fee: "total fee",
//   smart_degen_count: "smart-money holder count",
//   renowned_count: "KOL wallet count",
//   creator_balance_rate: "creator holding ratio (0–1)",
//   creator_created_count: "tokens this creator has launched",
//   creator_created_open_count: "tokens by this creator that graduated",
//   creator_created_open_ratio: "this creator's graduation ratio (0–1)",
//   x_follower: "X/Twitter follower count",
//   twitter_rename_count: "X/Twitter rename count",
//   tg_call_count: "Telegram call count",
// };

// token_top_holders and token_top_traders take the same query.
const holderQuery = {
  limit: limitOf(100, 20),
  order_by: oneOf(
    ["amount_percentage", "profit", "unrealized_profit", "buy_volume_cur", "sell_volume_cur"],
    "sort field (default amount_percentage). profit is realized USD; buy/sell_volume_cur shows who is accumulating or distributing",
  ),
  direction,
  tag: oneOf(
    ["smart_degen", "renowned", "fresh_wallet", "dev", "sniper", "rat_trader", "bundler", "transfer_in", "dex_bot", "bluechip_owner"],
    "return only wallets with this tag; omit for all wallets. Independent of order_by",
  ),
};

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
    { chain, address, ...holderQuery },
    ["chain", "address"],
    ({ chain, address, ...q }) => gmgnClient().getTokenTopHolders(chain, address, q),
  ),

  gmgn_token_top_traders: gmgnTool(
    "Get a token's top traders by realized P&L.",
    { chain, address, ...holderQuery },
    ["chain", "address"],
    ({ chain, address, ...q }) => gmgnClient().getTokenTopTraders(chain, address, q),
  ),

  gmgn_token_kline: gmgnTool(
    "Get OHLCV candlestick history for a token.",
    {
      chain,
      address,
      resolution: { type: "string", enum: ["30s", "1m", "5m", "15m", "1h", "4h", "1d"], description: "candle size" },
      from: { type: "number", description: "start time, Unix SECONDS. Omit for the most recent candles — 0 is not 'from the beginning', the API rejects it" },
      to: { type: "number", description: "end time, Unix seconds. Omit for now" },
    },
    ["chain", "address", "resolution"],
    // A sentinel `from: 0` / an out-of-range `to` is a 400 from the API ("must be a valid
    // timestamp in ms"), so treat anything non-positive as omitted rather than passing it on.
    ({ chain, address, resolution, from, to }) =>
      gmgnClient().getTokenKline(chain, address, resolution, from > 0 ? from * 1000 : undefined, to > 0 ? to * 1000 : undefined),
  ),

  // ---- GMGN: Wallet / portfolio ----

  gmgn_wallet_holdings: gmgnTool(
    "Get a wallet's current token holdings. Signed route — requires GMGN_PRIVATE_KEY.",
    {
      chain,
      walletAddress,
      limit: limitOf(50, 20),
      cursor,
      order_by: oneOf(
        ["usd_value", "last_active_timestamp", "realized_profit", "unrealized_profit", "total_profit", "history_bought_cost", "history_sold_income"],
        "sort field (default usd_value)",
      ),
      direction,
      hide_abnormal: flag("hide abnormal positions (default false)"),
      hide_airdrop: flag("hide airdrop positions (default true)"),
      hide_closed: flag("hide closed positions (default true)"),
      hide_open: flag("hide open positions"),
    },
    ["chain", "walletAddress"],
    ({ chain, walletAddress, ...q }) => gmgnClient().getWalletHoldings(chain, walletAddress, q),
  ),

  gmgn_wallet_activity: gmgnTool(
    "Get a wallet's recent trade activity.",
    {
      chain,
      walletAddress,
      token: { ...address, description: "only activity on this token (optional)" },
      limit: limitOf(50, 20),
      cursor,
      type: manyOf(["buy", "sell", "transferIn", "transferOut", "add", "remove"], "activity kinds to include; omit for all"),
    },
    ["chain", "walletAddress"],
    ({ chain, walletAddress, ...q }) => gmgnClient().getWalletActivity(chain, walletAddress, q),
  ),

  gmgn_wallet_stats: gmgnTool(
    "Get win rate, P&L, and trading stats for one or more wallets.",
    {
      chain,
      walletAddresses: { type: "array", items: { type: "string" }, description: "one or more wallet addresses" },
      period: oneOf(["7d", "30d"], "stats period (default 7d)"),
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
    {
      chain,
      walletAddress,
      order_by: oneOf(["market_cap", "token_ath_mc"], "sort field"),
      direction,
      migrate_state: oneOf(["migrated", "non_migrated"], "migrated = graduated to a DEX; non_migrated = still on the bonding curve"),
    },
    ["chain", "walletAddress"],
    ({ chain, walletAddress, ...q }) => gmgnClient().getCreatedTokens(chain, walletAddress, q),
  ),

  // ---- GMGN: Market discovery ----

  // The two rank feeds answer "which tokens exist", which is discovery, not analysis. The engine
  // still calls both — src/trading/market.ts goes straight to OpenApiClient, not through this
  // file — so the sweep is unaffected; what is gone is a model's ability to re-run it mid-cycle.
  // Uncomment to give the interactive CLI its browsing back.

  // gmgn_trenches: gmgnTool(
  //   "Browse launchpad tokens: new_creation, near_completion, or completed (graduated).",
  //   {
  //     chain,
  //     types: manyOf(["new_creation", "near_completion", "completed"], "categories to query (default all three)"),
  //     platforms: {
  //       type: "array",
  //       items: { type: "string" },
  //       description:
  //         "launchpad platform allow-list; omit for the chain default. sol: Pump.fun, letsbonk, bags, believe, boop, heaven, moonshot_app, ray_launchpad… · bsc: fourmeme, flap, clanker, lunafun… · base: clanker, flaunch, zora, bankr… · eth: trench, clanker, printr… — load the gmgn-market skill for the full per-chain list",
  //     },
  //     limit: limitOf(80, 80),
  //     filters: {
  //       type: "object",
  //       description: "server-side filters, applied before results are returned",
  //       properties: bounds(TRENCHES_BOUNDS),
  //       additionalProperties: true,
  //     },
  //   },
  //   ["chain"],
  //   ({ chain, types, platforms, limit, filters }) => gmgnClient().getTrenches(chain, types, platforms, limit, filters),
  // ),

  // gmgn_trending: gmgnTool(
  //   "Get trending/top tokens ranked by volume, price change, etc.",
  //   {
  //     chain,
  //     interval: oneOf(["1m", "5m", "1h", "6h", "24h"], "ranking window (default 1h)"),
  //     limit: limitOf(100, 100),
  //     order_by: oneOf(
  //       ["default", "swaps", "marketcap", "history_highest_market_cap", "liquidity", "volume", "holder_count", "smart_degen_count", "renowned_count", "gas_fee", "price", "change1m", "change5m", "change1h", "creation_timestamp"],
  //       "sort field",
  //     ),
  //     direction,
  //     filter: {
  //       type: "array",
  //       items: { type: "string" },
  //       description:
  //         "boolean tags. sol: renounced, frozen, burn, token_burnt, has_social, not_social_dup, not_image_dup, dexscr_update_link, not_wash_trading, is_internal_market, is_out_market · evm: not_honeypot, verified, renounced, locked, token_burnt, has_social, not_social_dup, not_image_dup, dexscr_update_link, is_internal_market, is_out_market. Omitting this is NOT 'no filter' — sol defaults to `renounced frozen`, evm to `not_honeypot verified renounced`",
  //     },
  //     platform: { type: "array", items: { type: "string" }, description: "launchpad/pool allow-list; see gmgn_trenches.platforms" },
  //     min_created: { type: "string", description: "minimum token age, duration with a unit: 30m, 6h, 7d. A bare number is rejected" },
  //     max_created: { type: "string", description: "maximum token age, same format" },
  //     ...bounds(RANK_BOUNDS),
  //   },
  //   ["chain", "interval"],
  //   ({ chain, interval, ...q }) => gmgnClient().getTrendingSwaps(chain, interval, q),
  // ),

  gmgn_token_signal: gmgnTool(
    "Get tokens matching signal criteria (e.g. smart-money buys, price spikes, ATH) grouped by filter.",
    {
      chain,
      groups: {
        type: "array",
        description: "one result group per entry",
        items: {
          type: "object",
          properties: {
            signal_type: { type: "array", items: { type: "number" }, description: "12 = smart-money buy, 6 = price spike, 7 = new ATH" },
            mc_min: { type: "number", description: "minimum current market cap (USD)" },
            mc_max: { type: "number", description: "maximum current market cap (USD)" },
            trigger_mc_min: { type: "number", description: "minimum market cap when the signal fired" },
            trigger_mc_max: { type: "number", description: "maximum market cap when the signal fired" },
            total_fee_min: { type: "number", description: "minimum total fee" },
            total_fee_max: { type: "number", description: "maximum total fee" },
            min_create_or_open_ts: { type: "string", description: "earliest creation/open timestamp, Unix seconds as a string" },
            max_create_or_open_ts: { type: "string", description: "latest creation/open timestamp, Unix seconds as a string" },
          },
        },
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
        description: "one query per chain/interval pair",
        items: {
          type: "object",
          properties: {
            chain,
            interval: oneOf(["1m", "5m", "1h", "6h", "24h"], "search window"),
            label: { type: "string", description: "free-form label echoed back on the matching result group" },
            filters: {
              type: "array",
              items: { type: "string" },
              description:
                "boolean tags. sol: renounced, frozen, burn, token_burnt, has_social, not_social_dup, not_image_dup, dexscr_update_link, not_wash_trading, is_internal_market, is_out_market · evm: not_honeypot, verified, renounced, locked, token_burnt, has_social, not_social_dup, not_image_dup, dexscr_update_link, is_internal_market, is_out_market. Omitting this is NOT 'no filter' — sol defaults to `renounced frozen`, evm to `not_honeypot verified renounced`",
            },
            limit: { type: "number", description: "results for this entry" },
            min_created: { type: "string", description: "minimum token age, duration with a unit: 30m, 6h, 7d" },
            max_created: { type: "string", description: "maximum token age, same format" },
            ...bounds(RANK_BOUNDS),
          },
          required: ["chain", "interval"],
        },
      },
    },
    ["params"],
    ({ params }) => gmgnClient().getHotSearches(params),
  ),

  // ---- GMGN: User / social ----

  gmgn_user_info: gmgnTool("Get the API key's own account info and bound wallets.", {}, [], () => gmgnClient().getUserInfo()),

  gmgn_follow_wallet: gmgnTool(
    "Get trade activity from wallets the account follows. Signed route — requires GMGN_PRIVATE_KEY.",
    {
      chain,
      wallet: { ...walletAddress, description: "only activity from this followed wallet (optional)" },
      limit: limitOf(100, 10),
      side: oneOf(["buy", "sell"], "trade direction"),
      filter: { type: "array", items: { type: "string" }, description: "filter tags" },
      min_amount_usd: { type: "number", description: "minimum trade size (USD)" },
      max_amount_usd: { type: "number", description: "maximum trade size (USD)" },
    },
    ["chain"],
    ({ chain, ...q }) => gmgnClient().getFollowWallet(chain, q),
  ),

  gmgn_follow_tokens: gmgnTool(
    "Get a wallet's followed/watchlisted tokens.",
    {
      chain,
      walletAddress,
      group_id: { type: "string", description: "`all_group` (every group), `default`, or a user-defined group id" },
      interval: oneOf(["1m", "5m", "1h", "6h", "24h"], "window for the price-change stats"),
      order_by: oneOf(["created_at", "swaps", "volume", "market_cap", "liquidity", "price", "open_timestamp"], "sort field"),
      direction: { ...direction, description: "sort direction — required when order_by is set" },
      limit: { type: "number", description: "results per page" },
      cursor,
      search: { type: "string", description: "match on token name or address" },
    },
    ["chain", "walletAddress"],
    ({ chain, walletAddress, ...q }) => gmgnClient().getFollowTokens(chain, walletAddress, q),
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

  // // ---- GMGN: Trade (reads) ----

  // gmgn_quote: gmgnTool(
  //   "Get a swap quote (expected output amount, price impact) without executing anything.",
  //   {
  //     chain,
  //     fromAddress: { type: "string", description: "the wallet that would send the swap" },
  //     inputToken: address,
  //     outputToken: { type: "string", description: "output token contract address" },
  //     inputAmount: { type: "string", description: "smallest-unit input amount" },
  //     slippage: { type: "number", description: "percent, e.g. 1 for 1%" },
  //   },
  //   ["chain", "fromAddress", "inputToken", "outputToken", "inputAmount", "slippage"],
  //   ({ chain, fromAddress, inputToken, outputToken, inputAmount, slippage }) =>
  //     gmgnClient().quoteOrder(chain, fromAddress, inputToken, outputToken, inputAmount, slippage),
  // ),

  // gmgn_gas_price: gmgnTool("Get the current native-token gas price and USD price for a chain.", { chain }, ["chain"], ({ chain }) =>
  //   gmgnClient().getGasPrice(chain),
  // ),

  // gmgn_query_order: gmgnTool(
  //   "Check the status of a previously submitted swap order. Signed route — requires GMGN_PRIVATE_KEY.",
  //   { orderId: { type: "string" }, chain },
  //   ["orderId", "chain"],
  //   ({ orderId, chain }) => gmgnClient().queryOrder(orderId, chain),
  // ),

  // gmgn_strategy_orders: gmgnTool(
  //   "List open strategy (conditional take-profit/stop-loss) orders. Signed route — requires GMGN_PRIVATE_KEY.",
  //   { chain, extra },
  //   ["chain"],
  //   ({ chain, extra }) => gmgnClient().getStrategyOrders(chain, extra ?? {}),
  // ),

  // gmgn_cooking_statistics: gmgnTool("Get platform-wide token-launch (\"cooking\") statistics.", {}, [], () =>
  //   gmgnClient().getCookingStatistics(),
  // ),

  // // ---- GMGN: Trade (spends real funds — refuses unless GMGN_ALLOW_AUTOMATED_TRADES=1) ----

  // gmgn_swap: gmgnTool(
  //   "Execute a real, irreversible on-chain swap. Refuses unless the operator set GMGN_ALLOW_AUTOMATED_TRADES=1 in this shell.",
  //   { params: { type: "object", additionalProperties: true, description: "SwapParams — chain, from_address, input_token, output_token, input_amount, slippage, plus optional fee/anti-mev/condition_orders fields" } },
  //   ["params"],
  //   ({ params }) => gmgnClient().swap(params),
  // ),

  // gmgn_multi_swap: gmgnTool(
  //   "Execute the same swap across multiple wallets at once. Refuses unless GMGN_ALLOW_AUTOMATED_TRADES=1 is set.",
  //   { params: { type: "object", additionalProperties: true, description: "MultiSwapParams — chain, accounts[], input_token, output_token, plus amount/fee fields" } },
  //   ["params"],
  //   ({ params }) => gmgnClient().multiSwap(params),
  // ),

  // gmgn_strategy_create: gmgnTool(
  //   "Create a conditional strategy order (e.g. take-profit / stop-loss that fires automatically). Commits future spend — refuses unless GMGN_ALLOW_AUTOMATED_TRADES=1 is set.",
  //   { params: { type: "object", additionalProperties: true, description: "StrategyCreateParams — chain, from_address, base_token, quote_token, order_type, sub_order_type, plus trigger/sizing fields" } },
  //   ["params"],
  //   ({ params }) => gmgnClient().createStrategyOrder(params),
  // ),

  // gmgn_strategy_cancel: gmgnTool(
  //   "Cancel an open strategy order. Signed route — requires GMGN_PRIVATE_KEY. Safe: this only removes a pending order, never spends.",
  //   { params: { type: "object", additionalProperties: true, description: "StrategyCancelParams — chain, from_address, order_id, plus optional order_type/close_sell_model" } },
  //   ["params"],
  //   ({ params }) => gmgnClient().cancelStrategyOrder(params),
  // ),

  // gmgn_create_token: gmgnTool(
  //   "Launch a new token on a launchpad and execute the creator's initial buy. Spends real funds — refuses unless GMGN_ALLOW_AUTOMATED_TRADES=1 is set.",
  //   { params: { type: "object", additionalProperties: true, description: "CreateTokenParams — chain, dex, from_address, name, symbol, buy_amt, image/image_url, plus many optional fields" } },
  //   ["params"],
  //   ({ params }) => gmgnClient().createToken(params),
  // ),
};
