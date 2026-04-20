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
  const result = await executeSwap({
    chain: params.chain,
    fromAddress: params.walletAddress,
    inputToken: params.tokenAddress,
    outputToken: SOL_ADDRESS,
    percent: params.percent,
    slippage: params.slippage,
  });

  return result;
}

export async function checkOrderStatus(chain: string, orderId: string) {
  return queryOrder(chain, orderId);
}
