import { $ } from "bun";
import { logger } from "../utils/logger";

interface GmgnResponse<T> {
  code: number;
  data: T;
  message?: string;
}

async function executeGmgnCommand<T>(args: string[]): Promise<T> {
  const timestamp = Math.floor(Date.now() / 1000);
  const clientId = crypto.randomUUID();

  // Append common flags
  const fullArgs = [...args, "--timestamp", timestamp.toString(), "--client-id", clientId];

  logger.debug("Executing gmgn-cli command", { args: fullArgs });

  try {
    const result = await $`gmgn-cli ${fullArgs}`.json();

    if (result.code !== 0) {
      throw new Error(result.message || `GMGN API Error: ${result.code}`);
    }

    return result.data as T;
  } catch (error) {
    logger.error("GMGN CLI execution failed", { error: String(error), args: fullArgs });
    throw error;
  }
}

// Trenches endpoint
export async function fetchTrenches(chain: string, filters: Record<string, any> = {}) {
  const args = ["trenches", "--chain", chain];

  // Apply server-side filters
  if (filters.filterPreset) args.push("--filter-preset", filters.filterPreset);
  if (filters.minSmartDegenCount) args.push("--min-smart-degen-count", filters.minSmartDegenCount.toString());
  if (filters.minMarketCap) args.push("--min-marketcap", filters.minMarketCap.toString());
  if (filters.maxMarketCap) args.push("--max-marketcap", filters.maxMarketCap.toString());
  if (filters.maxRugRatio) args.push("--max-rug-ratio", filters.maxRugRatio.toString());
  if (filters.maxBundlerRate) args.push("--max-bundler-rate", filters.maxBundlerRate.toString());
  if (filters.maxInsiderRatio) args.push("--max-insider-ratio", filters.maxInsiderRatio.toString());
  if (filters.sortBy) args.push("--sort-by", filters.sortBy);
  if (filters.limit) args.push("--limit", filters.limit.toString());

  return executeGmgnCommand<any>(args);
}

// Market endpoint - K-line data
export async function fetchKline(chain: string, address: string, resolution: string, from?: number, to?: number) {
  const args = ["market", "kline", "--chain", chain, "--address", address, "--resolution", resolution];
  if (from) args.push("--from", from.toString());
  if (to) args.push("--to", to.toString());

  return executeGmgnCommand<any>(args);
}

// Market endpoint - Top traders
export async function fetchTopTraders(chain: string, address: string, tag: string = "smart_degen", limit: number = 10) {
  const args = ["market", "token_top_traders", "--chain", chain, "--address", address, "--tag", tag, "--limit", limit.toString()];
  return executeGmgnCommand<any>(args);
}

// Trade endpoint - Execute swap
export async function executeSwap(params: {
  chain: string;
  fromAddress: string;
  inputToken: string;
  outputToken: string;
  inputAmount: string;
  slippage?: number;
  autoSlippage?: boolean;
}) {
  const args = [
    "swap",
    "--chain", params.chain,
    "--from", params.fromAddress,
    "--input-token", params.inputToken,
    "--output-token", params.outputToken,
    "--amount", params.inputAmount,
  ];

  if (params.slippage) args.push("--slippage", params.slippage.toString());
  if (params.autoSlippage) args.push("--auto-slippage");

  return executeGmgnCommand<any>(args);
}

// Trade endpoint - Query order status
export async function queryOrder(chain: string, orderId: string) {
  const args = ["order", "get", "--chain", chain, "--order-id", orderId];
  return executeGmgnCommand<any>(args);
}
