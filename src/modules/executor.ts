import { getGmgnClient, type SwapParams, type StrategyConditionOrder, type SwapResponse } from '../services/gmgn-client.ts';
import { getConfig } from '../config.ts';
import { logger } from '../utils/logger.ts';
import { insertTrade, updateTradeStatus, insertPosition, countOpenPositions } from '../db/queries.ts';
import { type EnrichedToken } from './scorer.ts';
import { SOL_ADDRESS, solToLamports, lamportsToSol, solscanTx } from '../utils/math.ts';
import { sleep, withRetry } from '../utils/retry.ts';

const ORDER_POLL_INTERVAL_MS = 3000;
const ORDER_POLL_TIMEOUT_MS = 60000; // 60s max wait for confirmation

/**
 * Build condition orders dynamically based on config.
 */
function buildConditionOrders(): StrategyConditionOrder[] {
  const config = getConfig();
  const orders: StrategyConditionOrder[] = [];

  if (config.stopLossPct) {
    orders.push({
      order_type: 'loss_stop',
      side: 'sell',
      price_scale: String(config.stopLossPct),
      sell_ratio: '100',
    });
  }

  if (config.trailingActivatePct && config.trailingDrawdownPct) {
    orders.push({
      order_type: 'profit_stop_trace',
      side: 'sell',
      price_scale: String(config.trailingActivatePct),
      drawdown_rate: String(config.trailingDrawdownPct),
      sell_ratio: '100',
    });
  }

  return orders;
}

/**
 * Check if we have room for a new position.
 */
export function canOpenPosition(): boolean {
  const config = getConfig();
  const open = countOpenPositions();
  if (open >= config.maxConcurrentPositions) {
    logger.warn('position_gate_blocked', {
      open,
      max: config.maxConcurrentPositions,
    });
    return false;
  }
  return true;
}

/**
 * Execute a buy order for a token candidate.
 * In DRY_RUN mode, simulates the buy without sending a real transaction.
 */
export async function executeBuy(enriched: EnrichedToken): Promise<boolean> {
  const config = getConfig();
  const client = getGmgnClient();
  const { candidate, info } = enriched;

  const inputAmountLamports = solToLamports(config.tradeSizeSol);
  const conditionOrders = buildConditionOrders();
  const hasConditionOrders = conditionOrders.length > 0;

  // ── DRY RUN ───────────────────────────────────────────────────────────────
  if (config.dryRun) {
    const simulatedOrderId = `dry_${Date.now()}_${candidate.mintAddress.slice(0, 8)}`;
    const simulatedPrice = parseFloat(info.price.price);

    insertTrade({
      mintAddress: candidate.mintAddress,
      side: 'BUY',
      solAmount: config.tradeSizeSol,
      tokenAmount: '0', // simulated
      priceUsd: simulatedPrice,
      orderId: simulatedOrderId,
      status: 'confirmed',
    });

    insertPosition({
      mintAddress: candidate.mintAddress,
      symbol: candidate.symbol,
      entryPriceUsd: simulatedPrice,
      solInvested: config.tradeSizeSol,
      tokenAmount: '0', // simulated
      entryHolderCount: info.stat?.holder_count,
      entrySmartWalletCount: info.wallet_tags_stat?.smart_wallets,
    });

    logger.info('buy_simulated', {
      mint: candidate.mintAddress,
      symbol: candidate.symbol,
      sol_amount: config.tradeSizeSol,
      price_usd: simulatedPrice,
      condition_orders: conditionOrders.length,
      order_id: simulatedOrderId,
    });

    return true;
  }

  // ── LIVE EXECUTION ────────────────────────────────────────────────────────
  const swapParams: SwapParams = {
    chain: 'sol',
    from_address: config.walletAddress,
    input_token: SOL_ADDRESS,
    output_token: candidate.mintAddress,
    input_amount: inputAmountLamports,
    slippage: config.slippage,
    auto_slippage: config.autoSlippage,
    is_anti_mev: config.antiMev,
    sell_ratio_type: 'hold_amount',
    ...(hasConditionOrders && {
      priority_fee: '0.00001',
      tip_fee: '0.00001',
      condition_orders: conditionOrders,
    }),
  };

  let swapResponse: SwapResponse;
  try {
    swapResponse = await withRetry(() => client.swap(swapParams), {
      maxAttempts: 2,
      baseDelayMs: 2000,
    });
  } catch (err) {
    logger.error('buy_failed', { mint: candidate.mintAddress, symbol: candidate.symbol, error: String(err) });
    return false;
  }

  logger.info('buy_submitted', {
    mint: candidate.mintAddress,
    symbol: candidate.symbol,
    sol_amount: config.tradeSizeSol,
    order_id: swapResponse.order_id,
    hash: swapResponse.hash,
    tx_url: solscanTx(swapResponse.hash),
    condition_orders: conditionOrders.length,
  });

  // Save trade as pending
  insertTrade({
    mintAddress: candidate.mintAddress,
    side: 'BUY',
    solAmount: config.tradeSizeSol,
    orderId: swapResponse.order_id,
    strategyOrderId: swapResponse.strategy_order_id,
    txHash: swapResponse.hash,
    status: 'pending',
  });

  // ── Poll until confirmed ───────────────────────────────────────────────────
  const confirmed = await pollOrderUntilConfirmed(swapResponse.order_id, ORDER_POLL_TIMEOUT_MS);

  if (!confirmed) {
    logger.error('buy_not_confirmed', { mint: candidate.mintAddress, order_id: swapResponse.order_id });
    updateTradeStatus(swapResponse.order_id, 'failed');
    return false;
  }

  const report = confirmed.report!;
  const tokenAmount = report.output_amount;
  const priceUsd = parseFloat(report.price_usd);
  const solSpent = lamportsToSol(report.input_amount, report.input_token_decimals);

  updateTradeStatus(swapResponse.order_id, 'confirmed', {
    tokenAmount,
    priceUsd,
    txHash: swapResponse.hash,
  });

  insertPosition({
    mintAddress: candidate.mintAddress,
    symbol: candidate.symbol,
    entryPriceUsd: priceUsd,
    solInvested: solSpent,
    tokenAmount,
    strategyOrderId: swapResponse.strategy_order_id,
    entryHolderCount: info.stat?.holder_count,
    entrySmartWalletCount: info.wallet_tags_stat?.smart_wallets,
  });

  logger.info('buy_confirmed', {
    mint: candidate.mintAddress,
    symbol: candidate.symbol,
    price_usd: priceUsd,
    sol_spent: solSpent,
    token_amount: tokenAmount,
    gas_usd: report.gas_usd,
    tx_url: solscanTx(swapResponse.hash),
  });

  return true;
}

/**
 * Execute a market sell (AI-triggered or time-limit).
 * Cancels condition orders first if they exist.
 */
export async function executeSell(params: {
  mintAddress: string;
  symbol: string | null;
  tokenAmount: string;
  strategyOrderId: string | null;
  reason: string;
  entryPriceUsd: number;
  solInvested: number;
  currentPriceUsd?: number;  // optional: if provided, skip token_info fetch in DRY_RUN
}): Promise<{ success: boolean; priceUsd?: number; solReceived?: number }> {
  const config = getConfig();
  const client = getGmgnClient();

  // ── DRY RUN ───────────────────────────────────────────────────────────────
  if (config.dryRun) {
    let exitPriceUsd = params.currentPriceUsd ?? params.entryPriceUsd; // use provided price or fallback to break even
    let solReceived = params.solInvested;

    // Only fetch if currentPriceUsd was not provided
    if (!params.currentPriceUsd) {
      try {
        const info = await client.getTokenInfo(params.mintAddress);
        exitPriceUsd = parseFloat(info.price.price);
      } catch {
        // fetch failed — fallback to break even
      }
    }

    if (params.entryPriceUsd > 0 && exitPriceUsd > 0) {
      solReceived = params.solInvested * (exitPriceUsd / params.entryPriceUsd);
    }

    logger.info('sell_simulated', {
      mint: params.mintAddress,
      symbol: params.symbol,
      reason: params.reason,
      exit_price_usd: exitPriceUsd,
      sol_received: solReceived,
    });

    return { success: true, priceUsd: exitPriceUsd, solReceived };
  }

  // ── Cancel condition orders first ──────────────────────────────────────────
  if (params.strategyOrderId) {
    try {
      await client.cancelStrategyOrder(params.strategyOrderId);
      logger.info('condition_order_cancelled', {
        mint: params.mintAddress,
        strategy_order_id: params.strategyOrderId,
      });
      await sleep(1000); // brief pause before sell
    } catch (err) {
      // Non-fatal: condition order may have already fired. Proceed with sell anyway.
      logger.warn('cancel_order_failed', {
        mint: params.mintAddress,
        strategy_order_id: params.strategyOrderId,
        error: String(err),
      });
    }
  }

  // ── Market sell ────────────────────────────────────────────────────────────
  const sellParams: SwapParams = {
    chain: 'sol',
    from_address: config.walletAddress,
    input_token: params.mintAddress,
    output_token: SOL_ADDRESS,
    input_amount: params.tokenAmount,
    slippage: config.slippage,
    is_anti_mev: config.antiMev,
  };

  let swapResponse: SwapResponse;
  try {
    swapResponse = await withRetry(() => client.swap(sellParams), {
      maxAttempts: 3,
      baseDelayMs: 3000,
    });
  } catch (err) {
    logger.error('sell_failed', {
      mint: params.mintAddress,
      reason: params.reason,
      error: String(err),
    });
    return { success: false };
  }

  logger.info('sell_submitted', {
    mint: params.mintAddress,
    symbol: params.symbol,
    reason: params.reason,
    order_id: swapResponse.order_id,
    hash: swapResponse.hash,
    tx_url: solscanTx(swapResponse.hash),
  });

  insertTrade({
    mintAddress: params.mintAddress,
    side: 'SELL',
    solAmount: 0,
    orderId: swapResponse.order_id,
    txHash: swapResponse.hash,
    status: 'pending',
  });

  // ── Poll until confirmed ───────────────────────────────────────────────────
  const confirmed = await pollOrderUntilConfirmed(swapResponse.order_id, ORDER_POLL_TIMEOUT_MS);

  if (!confirmed) {
    logger.error('sell_not_confirmed', {
      mint: params.mintAddress,
      order_id: swapResponse.order_id,
    });
    updateTradeStatus(swapResponse.order_id, 'failed');
    return { success: false };
  }

  const report = confirmed.report!;
  const priceUsd = parseFloat(report.price_usd);
  const solReceived = lamportsToSol(report.output_amount, report.output_token_decimals);

  updateTradeStatus(swapResponse.order_id, 'confirmed', {
    priceUsd,
    txHash: swapResponse.hash,
  });

  logger.info('sell_confirmed', {
    mint: params.mintAddress,
    symbol: params.symbol,
    reason: params.reason,
    price_usd: priceUsd,
    sol_received: solReceived,
    gas_usd: report.gas_usd,
    tx_url: solscanTx(swapResponse.hash),
  });

  return { success: true, priceUsd, solReceived };
}

/**
 * Poll order status until confirmed, failed, or timeout.
 */
async function pollOrderUntilConfirmed(
  orderId: string,
  timeoutMs: number
) {
  const client = getGmgnClient();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await sleep(ORDER_POLL_INTERVAL_MS);

    try {
      const status = await client.queryOrder(orderId);

      if (status.status === 'confirmed' || status.status === 'successful') {
        return status;
      }

      if (status.status === 'failed' || status.status === 'expired') {
        logger.warn('order_terminal_status', { order_id: orderId, status: status.status });
        return null;
      }

      // still pending/processed — keep polling
    } catch (err) {
      logger.warn('order_poll_error', { order_id: orderId, error: String(err) });
    }
  }

  logger.warn('order_poll_timeout', { order_id: orderId, timeoutMs });
  return null;
}
