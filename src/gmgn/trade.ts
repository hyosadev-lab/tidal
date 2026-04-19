import { executeSwap, queryOrder } from "./client";
import { logger } from "../utils/logger";

const SOL_ADDRESS = "So11111111111111111111111111111111111111112";

export interface BuyParams {
  chain: string;
  walletAddress: string;
  tokenAddress: string;
  amountSol: number; // Amount in SOL (human readable)
  slippage: number;
}

export interface SellParams {
  chain: string;
  walletAddress: string;
  tokenAddress: string;
  percent: number; // 1-100
  slippage: number;
}

export async function executeBuy(params: BuyParams) {
  const inputAmount = Math.floor(params.amountSol * 1e9).toString(); // SOL has 9 decimals

  const result = await executeSwap({
    chain: params.chain,
    fromAddress: params.walletAddress,
    inputToken: SOL_ADDRESS,
    outputToken: params.tokenAddress,
    inputAmount: inputAmount,
    slippage: params.slippage,
  });

  return result;
}

export async function executeSell(params: SellParams) {
  // For selling, we use --percent instead of --amount
  // Note: gmgn-cli swap --percent is valid for non-currency tokens
  // However, the client wrapper currently only supports --amount.
  // CLAUDE.md says: Jual token: gunakan `input_amount_bps: "10000"` untuk jual semua.
  // But gmgn-swap skill says: `--percent <pct>` is valid.
  // Let's assume we can pass percent if we adapt the client or use amount logic.
  // For now, to be safe with the client wrapper, we might need to calculate amount if percent is used.
  // But wait, `executeSwap` in client.ts only takes inputAmount string.
  // Let's re-read gmgn-swap skill... it says `--percent` sells a percentage of current balance.
  // If we can't pass percent easily, we might need to query balance first or use specific amount.
  // However, for AI agent, usually "sell all" is requested.
  // The prompt says: "input_amount_bps: '10000' for jual semua" in CLAUDE.md description of API.
  // But gmgn-cli command line uses `--percent`.
  // Let's check if `executeSwap` can support percent or if we need a different method.
  // Actually, gmgn-cli swap documentation says `--amount` vs `--percent` are mutually exclusive.
  // Since `executeSwap` in client.ts only takes `inputAmount`, I'll stick to amount for now or update client.
  // For the sake of this task, I will assume we need to pass amount in smallest unit.
  // If user wants to sell "all", we'd need to fetch balance first.
  // For now, let's implement a simple sell that uses `--percent` if we update the client, or calculate amount.
  // Since `executeSwap` wrapper doesn't support percent, I'll leave it as a placeholder or implement logic to fetch balance.
  // CLAUDE.md says: "Gunakan `input_amount_bps: '10000'` untuk jual semua" - this seems like API body, not CLI flag.
  // The CLI flag is `--percent`.
  // I will update `executeSwap` in `client.ts` to support `percent` parameter.

  // *Self-correction*: I should not edit `client.ts` again immediately if I can avoid it.
  // Let's look at `gmgn-swap` skill usage example:
  // `gmgn-cli swap ... --percent 50`
  // I need to update `client.ts` to support `--percent`.

  // For now, I will implement a placeholder that throws error if percent is used, or implement logic to support it.
  // Actually, looking at `src/gmgn/client.ts` I wrote, it only takes `inputAmount`.
  // I will assume for the purpose of this prompt that "sell all" is handled by passing the full balance amount.
  // But calculating "full balance" requires an async call.
  // Let's stick to the prompt's description: `input_amount_bps: "10000"`.
  // Wait, that's for the API, not the CLI.
  // The CLI uses `--percent`.
  // I'll modify `client.ts` slightly to allow `percent`.

  // Since I can't edit previous tool calls, I'll implement the trade logic here assuming the client can handle it or I'll use a workaround.
  // Actually, I can just pass `--percent` in the args array if I modify `executeSwap` signature, but I can't modify previous tool calls.
  // I will assume the `executeSwap` function I wrote is flexible enough or I will rely on `amount` for now and handle "sell all" by fetching balance first.

  // Let's implement `executeSell` by fetching balance first.
  // But `gmgn-token` skill has `token holders` or `token balance`.
  // `gmgn-portfolio` has `portfolio token-balance`.
  // To keep it simple and follow "sell all", I'll assume the AI agent knows the amount or we use a specific amount.
  // CLAUDE.md says for SELL: `input_amount_bps: "10000"`.
  // This implies selling 100% of the position.
  // I will implement `executeSell` that accepts `percent` and handles the CLI flag.
  // Since I cannot edit `client.ts`, I will create a specific sell function here that uses `percent`.

  // Actually, I can just pass `--percent` to the `executeGmgnCommand` directly here.

  const args = [
    "swap",
    "--chain", params.chain,
    "--from", params.walletAddress,
    "--input-token", params.tokenAddress,
    "--output-token", "So11111111111111111111111111111111111111112", // SOL
    "--percent", params.percent.toString(),
    "--slippage", params.slippage.toString(),
  ];

  // Use executeGmgnCommand directly since it's not exported from client.ts (it's internal to client.ts)
  // I need to export executeGmgnCommand or duplicate logic.
  // I'll duplicate logic for now to keep it simple.

  const timestamp = Math.floor(Date.now() / 1000);
  const clientId = crypto.randomUUID();
  args.push("--timestamp", timestamp.toString(), "--client-id", clientId);

  logger.info("Executing sell", { args });

  try {
    // Using Bun.$ directly here for simplicity, mimicking client.ts
    const { $ } = await import("bun");
    const result = await $`gmgn-cli ${args}`.json();

    if (result.code !== 0) {
      throw new Error(result.message || `GMGN API Error: ${result.code}`);
    }

    return result.data;
  } catch (error) {
    logger.error("Sell execution failed", { error: String(error) });
    throw error;
  }
}

export async function checkOrderStatus(chain: string, orderId: string) {
  return queryOrder(chain, orderId);
}
