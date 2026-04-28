import { $ } from "bun";
import { logger } from "../utils/logger";

// Rate limiter: delay 500ms antar request
let lastRequestTime = 0;
const RATE_LIMIT_MS = 100;

async function executeGmgnCommand<T>(args: string[]): Promise<T> {
  // Enforce rate limit
  const now = Date.now();
  const timeSinceLast = now - lastRequestTime;
  if (timeSinceLast < RATE_LIMIT_MS) {
    await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_MS - timeSinceLast));
  }
  lastRequestTime = Date.now();

  logger.debug("Executing gmgn-cli command", { args });

  try {
    // Execute command and try to parse as JSON
    const result = await $`gmgn-cli ${args}`.json();

    // Check if result is an object and has code property
    if (result && typeof result === 'object' && 'code' in result) {
      if (result.code !== 0) {
        throw new Error(result.message || `GMGN API Error: ${result.code}`);
      }

      // Return data if available, otherwise return the whole result
      return (result.data || result) as T;
    }

    // If result doesn't have code property, assume it's successful data
    return result as T;
  } catch (error) {
    // If JSON parsing fails, it might be a text error message
    logger.error("GMGN CLI execution failed", { error: String(error), args });
    throw error;
  }
}

// Trenches endpoint
export async function fetchTrenches(chain: string) {
  const args = [
    "market",
    "trenches",
    "--chain", chain,
  ];

  // Sort and limit
  if (process.env.GMGN_SORT_BY) args.push("--sort-by", process.env.GMGN_SORT_BY);
  if (process.env.GMGN_LIMIT) args.push("--limit", process.env.GMGN_LIMIT);
  if (process.env.GMGN_TYPE) args.push("--type", process.env.GMGN_TYPE);
  if (process.env.GMGN_LAUNCHPAD_PLATFORM) {
    const launchpadPlatform = process.env.GMGN_LAUNCHPAD_PLATFORM.split(",")
    for (let i = 0; i < launchpadPlatform.length; i++) {
      args.push("--launchpad-platform", launchpadPlatform[i]);
    }
  }

  // Apply server-side filters from environment variables
  if (process.env.GMGN_FILTER_PRESET) args.push("--filter-preset", process.env.GMGN_FILTER_PRESET);

  // Volume filters
  if (process.env.GMGN_MIN_VOLUME_24H) args.push("--min-volume-24h", process.env.GMGN_MIN_VOLUME_24H);
  if (process.env.GMGN_MAX_VOLUME_24H) args.push("--max-volume-24h", process.env.GMGN_MAX_VOLUME_24H);

  // Net buy filters
  if (process.env.GMGN_MIN_NET_BUY_24H) args.push("--min-net-buy-24h", process.env.GMGN_MIN_NET_BUY_24H);
  if (process.env.GMGN_MAX_NET_BUY_24H) args.push("--max-net-buy-24h", process.env.GMGN_MAX_NET_BUY_24H);

  // Swap count filters
  if (process.env.GMGN_MIN_SWAPS_24H) args.push("--min-swaps-24h", process.env.GMGN_MIN_SWAPS_24H);
  if (process.env.GMGN_MAX_SWAPS_24H) args.push("--max-swaps-24h", process.env.GMGN_MAX_SWAPS_24H);

  // Buy count filters
  if (process.env.GMGN_MIN_BUYS_24H) args.push("--min-buys-24h", process.env.GMGN_MIN_BUYS_24H);
  if (process.env.GMGN_MAX_BUYS_24H) args.push("--max-buys-24h", process.env.GMGN_MAX_BUYS_24H);

  // Sell count filters
  if (process.env.GMGN_MIN_SELLS_24H) args.push("--min-sells-24h", process.env.GMGN_MIN_SELLS_24H);
  if (process.env.GMGN_MAX_SELLS_24H) args.push("--max-sells-24h", process.env.GMGN_MAX_SELLS_24H);

  // Visiting count filters
  if (process.env.GMGN_MIN_VISITING_COUNT) args.push("--min-visiting-count", process.env.GMGN_MIN_VISITING_COUNT);
  if (process.env.GMGN_MAX_VISITING_COUNT) args.push("--max-visiting-count", process.env.GMGN_MAX_VISITING_COUNT);

  // Progress filters
  if (process.env.GMGN_MIN_PROGRESS) args.push("--min-progress", process.env.GMGN_MIN_PROGRESS);
  if (process.env.GMGN_MAX_PROGRESS) args.push("--max-progress", process.env.GMGN_MAX_PROGRESS);

  // Market cap filters
  if (process.env.GMGN_MIN_MARKETCAP) args.push("--min-marketcap", process.env.GMGN_MIN_MARKETCAP);
  if (process.env.GMGN_MAX_MARKETCAP) args.push("--max-marketcap", process.env.GMGN_MAX_MARKETCAP);

  // Liquidity filters
  if (process.env.GMGN_MIN_LIQUIDITY) args.push("--min-liquidity", process.env.GMGN_MIN_LIQUIDITY);
  if (process.env.GMGN_MAX_LIQUIDITY) args.push("--max-liquidity", process.env.GMGN_MAX_LIQUIDITY);

  // Token age filters
  if (process.env.GMGN_MIN_CREATED) args.push("--min-created", process.env.GMGN_MIN_CREATED);
  if (process.env.GMGN_MAX_CREATED) args.push("--max-created", process.env.GMGN_MAX_CREATED);

  // Holder count filters
  if (process.env.GMGN_MIN_HOLDER_COUNT) args.push("--min-holder-count", process.env.GMGN_MIN_HOLDER_COUNT);
  if (process.env.GMGN_MAX_HOLDER_COUNT) args.push("--max-holder-count", process.env.GMGN_MAX_HOLDER_COUNT);

  // Top holder rate filters
  if (process.env.GMGN_MIN_TOP_HOLDER_RATE) args.push("--min-top-holder-rate", process.env.GMGN_MIN_TOP_HOLDER_RATE);
  if (process.env.GMGN_MAX_TOP_HOLDER_RATE) args.push("--max-top-holder-rate", process.env.GMGN_MAX_TOP_HOLDER_RATE);

  // Rug ratio filters
  if (process.env.GMGN_MIN_RUG_RATIO) args.push("--min-rug-ratio", process.env.GMGN_MIN_RUG_RATIO);
  if (process.env.GMGN_MAX_RUG_RATIO) args.push("--max-rug-ratio", process.env.GMGN_MAX_RUG_RATIO);

  // Bundler rate filters
  if (process.env.GMGN_MIN_BUNDLER_RATE) args.push("--min-bundler-rate", process.env.GMGN_MIN_BUNDLER_RATE);
  if (process.env.GMGN_MAX_BUNDLER_RATE) args.push("--max-bundler-rate", process.env.GMGN_MAX_BUNDLER_RATE);

  // Insider ratio filters
  if (process.env.GMGN_MIN_INSIDER_RATIO) args.push("--min-insider-ratio", process.env.GMGN_MIN_INSIDER_RATIO);
  if (process.env.GMGN_MAX_INSIDER_RATIO) args.push("--max-insider-ratio", process.env.GMGN_MAX_INSIDER_RATIO);

  // Entrapment ratio filters
  if (process.env.GMGN_MIN_ENTRAPMENT_RATIO) args.push("--min-entrapment-ratio", process.env.GMGN_MIN_ENTRAPMENT_RATIO);
  if (process.env.GMGN_MAX_ENTRAPMENT_RATIO) args.push("--max-entrapment-ratio", process.env.GMGN_MAX_ENTRAPMENT_RATIO);

  // Private vault hold rate filters
  if (process.env.GMGN_MIN_PRIVATE_VAULT_HOLD_RATE) args.push("--min-private-vault-hold-rate", process.env.GMGN_MIN_PRIVATE_VAULT_HOLD_RATE);
  if (process.env.GMGN_MAX_PRIVATE_VAULT_HOLD_RATE) args.push("--max-private-vault-hold-rate", process.env.GMGN_MAX_PRIVATE_VAULT_HOLD_RATE);

  // Top-70 sniper hold rate filters
  if (process.env.GMGN_MIN_TOP70_SNIPER_HOLD_RATE) args.push("--min-top70-sniper-hold-rate", process.env.GMGN_MIN_TOP70_SNIPER_HOLD_RATE);
  if (process.env.GMGN_MAX_TOP70_SNIPER_HOLD_RATE) args.push("--max-top70-sniper-hold-rate", process.env.GMGN_MAX_TOP70_SNIPER_HOLD_RATE);

  // Bot count filters
  if (process.env.GMGN_MIN_BOT_COUNT) args.push("--min-bot-count", process.env.GMGN_MIN_BOT_COUNT);
  if (process.env.GMGN_MAX_BOT_COUNT) args.push("--max-bot-count", process.env.GMGN_MAX_BOT_COUNT);

  // Bot degen rate filters
  if (process.env.GMGN_MIN_BOT_DEGEN_RATE) args.push("--min-bot-degen-rate", process.env.GMGN_MIN_BOT_DEGEN_RATE);
  if (process.env.GMGN_MAX_BOT_DEGEN_RATE) args.push("--max-bot-degen-rate", process.env.GMGN_MAX_BOT_DEGEN_RATE);

  // Fresh wallet rate filters
  if (process.env.GMGN_MIN_FRESH_WALLET_RATE) args.push("--min-fresh-wallet-rate", process.env.GMGN_MIN_FRESH_WALLET_RATE);
  if (process.env.GMGN_MAX_FRESH_WALLET_RATE) args.push("--max-fresh-wallet-rate", process.env.GMGN_MAX_FRESH_WALLET_RATE);

  // Total fee filters
  if (process.env.GMGN_MIN_TOTAL_FEE) args.push("--min-total-fee", process.env.GMGN_MIN_TOTAL_FEE);
  if (process.env.GMGN_MAX_TOTAL_FEE) args.push("--max-total-fee", process.env.GMGN_MAX_TOTAL_FEE);

  // Smart degen count filters
  if (process.env.GMGN_MIN_SMART_DEGEN_COUNT) args.push("--min-smart-degen-count", process.env.GMGN_MIN_SMART_DEGEN_COUNT);
  if (process.env.GMGN_MAX_SMART_DEGEN_COUNT) args.push("--max-smart-degen-count", process.env.GMGN_MAX_SMART_DEGEN_COUNT);

  // Renowned count filters
  if (process.env.GMGN_MIN_RENOWNED_COUNT) args.push("--min-renowned-count", process.env.GMGN_MIN_RENOWNED_COUNT);
  if (process.env.GMGN_MAX_RENOWNED_COUNT) args.push("--max-renowned-count", process.env.GMGN_MAX_RENOWNED_COUNT);

  // Creator balance rate filters
  if (process.env.GMGN_MIN_CREATOR_BALANCE_RATE) args.push("--min-creator-balance-rate", process.env.GMGN_MIN_CREATOR_BALANCE_RATE);
  if (process.env.GMGN_MAX_CREATOR_BALANCE_RATE) args.push("--max-creator-balance-rate", process.env.GMGN_MAX_CREATOR_BALANCE_RATE);

  // Creator created count filters
  if (process.env.GMGN_MIN_CREATOR_CREATED_COUNT) args.push("--min-creator-created-count", process.env.GMGN_MIN_CREATOR_CREATED_COUNT);
  if (process.env.GMGN_MAX_CREATOR_CREATED_COUNT) args.push("--max-creator-created-count", process.env.GMGN_MAX_CREATOR_CREATED_COUNT);

  // Creator created open count filters
  if (process.env.GMGN_MIN_CREATOR_CREATED_OPEN_COUNT) args.push("--min-creator-created-open-count", process.env.GMGN_MIN_CREATOR_CREATED_OPEN_COUNT);
  if (process.env.GMGN_MAX_CREATOR_CREATED_OPEN_COUNT) args.push("--max-creator-created-open-count", process.env.GMGN_MAX_CREATOR_CREATED_OPEN_COUNT);

  // Creator created open ratio filters
  if (process.env.GMGN_MIN_CREATOR_CREATED_OPEN_RATIO) args.push("--min-creator-created-open-ratio", process.env.GMGN_MIN_CREATOR_CREATED_OPEN_RATIO);
  if (process.env.GMGN_MAX_CREATOR_CREATED_OPEN_RATIO) args.push("--max-creator-created-open-ratio", process.env.GMGN_MAX_CREATOR_CREATED_OPEN_RATIO);

  // X follower filters
  if (process.env.GMGN_MIN_X_FOLLOWER) args.push("--min-x-follower", process.env.GMGN_MIN_X_FOLLOWER);
  if (process.env.GMGN_MAX_X_FOLLOWER) args.push("--max-x-follower", process.env.GMGN_MAX_X_FOLLOWER);

  // Twitter rename count filters
  if (process.env.GMGN_MIN_TWITTER_RENAME_COUNT) args.push("--min-twitter-rename-count", process.env.GMGN_MIN_TWITTER_RENAME_COUNT);
  if (process.env.GMGN_MAX_TWITTER_RENAME_COUNT) args.push("--max-twitter-rename-count", process.env.GMGN_MAX_TWITTER_RENAME_COUNT);

  // Telegram call count filters
  if (process.env.GMGN_MIN_TG_CALL_COUNT) args.push("--min-tg-call-count", process.env.GMGN_MIN_TG_CALL_COUNT);
  if (process.env.GMGN_MAX_TG_CALL_COUNT) args.push("--max-tg-call-count", process.env.GMGN_MAX_TG_CALL_COUNT);

  return executeGmgnCommand<any>(args);
}

// Market endpoint - K-line data
export async function fetchKline(chain: string, address: string, resolution: string, from?: number, to?: number) {
  const args = ["market", "kline", "--chain", chain, "--address", address, "--resolution", resolution];
  if (from) args.push("--from", from.toString());
  if (to) args.push("--to", to.toString());
  args.push("--raw");

  return executeGmgnCommand<any>(args);
}

// Token endpoint - Top traders
export async function fetchTopTraders(chain: string, address: string, tag: string = "smart_degen", limit: number = 10) {
  // Use 'token traders' command from gmgn-token skill
  // Note: gmgn-token's 'token traders' uses --tag to filter by wallet type
  const args = ["token", "traders", "--chain", chain, "--address", address, "--tag", tag, "--limit", limit.toString(), "--raw"];
  return executeGmgnCommand<any>(args);
}

// Token endpoint - Token info
export async function fetchTokenInfo(chain: string, address: string) {
  const args = ["token", "info", "--chain", chain, "--address", address, "--raw"];
  return executeGmgnCommand<any>(args);
}

// Token endpoint - Token security
export async function fetchTokenSecurity(chain: string, address: string) {
  const args = ["token", "security", "--chain", chain, "--address", address, "--raw"];
  return executeGmgnCommand<any>(args);
}

// Trade endpoint - Execute swap
export async function executeSwap(params: {
  chain: string;
  fromAddress: string;
  inputToken: string;
  outputToken: string;
  inputAmount?: string;
  percent?: number;
  slippage?: number;
  autoSlippage?: boolean;
}) {
  const args = [
    "swap",
    "--chain", params.chain,
    "--from", params.fromAddress,
    "--input-token", params.inputToken,
    "--output-token", params.outputToken,
  ];

  // Use --amount or --percent (mutually exclusive)
  if (params.inputAmount) {
    args.push("--amount", params.inputAmount);
  } else if (params.percent !== undefined) {
    args.push("--percent", params.percent.toString());
  }

  if (params.slippage) args.push("--slippage", params.slippage.toString());
  if (params.autoSlippage) args.push("--auto-slippage");

  return executeGmgnCommand<any>(args);
}

// Trade endpoint - Query order status
export async function queryOrder(chain: string, orderId: string) {
  const args = ["order", "get", "--chain", chain, "--order-id", orderId];
  return executeGmgnCommand<any>(args);
}
