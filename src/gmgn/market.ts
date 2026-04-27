import { fetchKline, fetchTopTraders, fetchTokenTraders, fetchTokenInfo, fetchTokenSecurity } from "./client";
import { getVolumeDeltasFromKline } from "../utils/kline";

export interface TokenInfo {
  price: number;
  liquidity: number;
  holderCount: number;
  smartDegenCount: number;
  renownedCount: number;
  usdMarketCap: number;
  launchpadPlatform: string;
  creatorTokenStatus: string;
  rugRatio: number;
  isWashTrading: boolean;
  top10HolderRate: number;
  creatorBalanceRate: number;
  bundlerTraderAmountRate: number;
  ratTraderAmountRate: number;
  renouncedMint: boolean;
  renouncedFreezeAccount: boolean;
  hasAtLeastOneSocial: boolean;
  ctoFlag: boolean;
}

export async function getTokenInfo(chain: string, address: string): Promise<Partial<TokenInfo>> {
  try {
    const info = await fetchTokenInfo(chain, address);

    return {
      price: parseFloat(info.price) || 0,
      liquidity: parseFloat(info.liquidity) || 0,
      holderCount: info.holder_count || 0,
      smartDegenCount: info.wallet_tags_stat?.smart_wallets || 0,
      renownedCount: info.wallet_tags_stat?.renowned_wallets || 0,
      usdMarketCap: parseFloat(info.price) * parseFloat(info.circulating_supply) || 0,
      launchpadPlatform: info.launchpad_platform || "",
      top10HolderRate: parseFloat(info.stat?.top_10_holder_rate) || 0,
      creatorBalanceRate: parseFloat(info.stat?.creator_hold_rate) || 0,
      creatorTokenStatus: info.dev?.creator_token_status === "sell" ? "creator_close" : "creator_hold",
    };
  } catch (error) {
    console.error("Error fetching token info:", error);
    return {};
  }
}

export async function getTokenSecurity(chain: string, address: string): Promise<Partial<TokenInfo>> {
  try {
    const security = await fetchTokenSecurity(chain, address);

    return {
      rugRatio: parseFloat(security.rug_ratio) || 0,
      isWashTrading: security.is_wash_trading || false,
      creatorTokenStatus: security.creator_token_status === "creator_close" ? "creator_close" : "creator_hold",
      bundlerTraderAmountRate: parseFloat(security.bundler_trader_amount_rate) || 0,
      ratTraderAmountRate: parseFloat(security.rat_trader_amount_rate) || 0,
      renouncedMint: security.renounced_mint || false,
      renouncedFreezeAccount: security.renounced_freeze_account || false,
      hasAtLeastOneSocial: security.has_at_least_one_social || false,
      ctoFlag: security.cto_flag || false,
    };
  } catch (error) {
    console.error("Error fetching token security:", error);
    return {};
  }
}

export interface OrderFlowSummary {
  buyVolume: number;
  sellVolume: number;
  netFlowUsd: number;
  buySellRatio: number;
  intensity: "bullish" | "bearish" | "neutral";
  smartMoneyNetFlow: number;
  smartMoneyBuyCount: number;
  smartMoneySellCount: number;
}

export interface TokenDetails {
  kline1mData: string;
  topTradersSummary: string;
  orderFlowSummary: OrderFlowSummary;
  price: number;
  priceChange5m: number;
  volume5m: number;
  volumeDeltas1m: string;
}

export async function getOrderFlowSummary(
  chain: string,
  address: string,
  existingTraders?: any[]
): Promise<OrderFlowSummary> {
  try {
    // Use existing traders data if provided, otherwise fetch
    let traders: any[];
    if (existingTraders && existingTraders.length > 0) {
      traders = existingTraders;
    } else {
      const tradersResult = await fetchTokenTraders(chain, address, 50);
      traders = tradersResult?.list || [];
    }

    let totalBuyVolume = 0;
    let totalSellVolume = 0;
    let smartMoneyNetFlow = 0;
    let smartMoneyBuyCount = 0;
    let smartMoneySellCount = 0;

    traders.forEach((t: any) => {
      const isSmartDegen = t.tags?.includes("smart_degen") || false;
      const netflow = parseFloat(t.netflow_usd) || 0;

      // Track total volumes
      if (netflow > 0) {
        totalBuyVolume += netflow;
        if (isSmartDegen) {
          smartMoneyBuyCount++;
          smartMoneyNetFlow += netflow;
        }
      } else if (netflow < 0) {
        totalSellVolume += Math.abs(netflow);
        if (isSmartDegen) {
          smartMoneySellCount++;
          smartMoneyNetFlow += netflow; // netflow is negative for sells
        }
      }
    });

    const totalVolume = totalBuyVolume + totalSellVolume;
    const netFlow = totalBuyVolume - totalSellVolume;
    const buySellRatio = totalSellVolume > 0 ? totalBuyVolume / totalSellVolume : (totalBuyVolume > 0 ? 999 : 1);

    // Determine intensity based on net flow and volume
    let intensity: "bullish" | "bearish" | "neutral";
    if (netFlow > totalVolume * 0.1) {
      intensity = "bullish";
    } else if (netFlow < -totalVolume * 0.1) {
      intensity = "bearish";
    } else {
      intensity = "neutral";
    }

    return {
      buyVolume: totalBuyVolume,
      sellVolume: totalSellVolume,
      netFlowUsd: netFlow,
      buySellRatio,
      intensity,
      smartMoneyNetFlow,
      smartMoneyBuyCount,
      smartMoneySellCount,
    };
  } catch (error) {
    console.error("Error fetching order flow data:", error);
    return {
      buyVolume: 0,
      sellVolume: 0,
      netFlowUsd: 0,
      buySellRatio: 1,
      intensity: "neutral",
      smartMoneyNetFlow: 0,
      smartMoneyBuyCount: 0,
      smartMoneySellCount: 0,
    };
  }
}

export async function getTokenDetails(chain: string, address: string): Promise<TokenDetails> {
  try {
    const now = Math.floor(Date.now() / 1000);
    const from1m = now - 1800; // 30 minutes ago for context

    // Parallel fetch: traders, 1m kline
    const [tradersResult, kline1mResult] = await Promise.all([
      fetchTopTraders(chain, address, "smart_degen", 50),
      fetchKline(chain, address, "1m", from1m, now),
    ]);

    const traders = tradersResult?.list || [];
    const kline1mData = kline1mResult?.list || [];

    // Calculate Order Flow (reuse traders data)
    const orderFlowSummary = calculateOrderFlow(traders);

    // Process K-line Data
    const { kline1mSummary, currentPrice, volume5m, priceChange5m, volumeDeltas1m } = processKlineData(kline1mData);

    // Process Traders Summary
    const tradersSummary = formatTradersSummary(traders);

    return {
      kline1mData: kline1mSummary,
      topTradersSummary: tradersSummary,
      orderFlowSummary,
      price: currentPrice,
      priceChange5m: priceChange5m,
      volume5m: volume5m,
      volumeDeltas1m: volumeDeltas1m,
    };
  } catch (error) {
    console.error("Error fetching token details:", error);
    return {
      kline1mData: "",
      topTradersSummary: "",
      orderFlowSummary: {
        buyVolume: 0,
        sellVolume: 0,
        netFlowUsd: 0,
        buySellRatio: 1,
        intensity: "neutral",
        smartMoneyNetFlow: 0,
        smartMoneyBuyCount: 0,
        smartMoneySellCount: 0,
      },
      price: 0,
      priceChange5m: 0,
      volume5m: 0,
      volumeDeltas1m: "",
    };
  }
}

function calculateOrderFlow(traders: any[]): OrderFlowSummary {
  let totalBuyVolume = 0;
  let totalSellVolume = 0;
  let smartMoneyNetFlow = 0;
  let smartMoneyBuyCount = 0;
  let smartMoneySellCount = 0;

  traders.forEach((t: any) => {
    const isSmartDegen = t.tags?.includes("smart_degen") || false;
    const netflow = parseFloat(t.netflow_usd) || 0;

    if (netflow > 0) {
      totalBuyVolume += netflow;
      if (isSmartDegen) {
        smartMoneyBuyCount++;
        smartMoneyNetFlow += netflow;
      }
    } else if (netflow < 0) {
      totalSellVolume += Math.abs(netflow);
      if (isSmartDegen) {
        smartMoneySellCount++;
        smartMoneyNetFlow += netflow;
      }
    }
  });

  const totalVolume = totalBuyVolume + totalSellVolume;
  const netFlow = totalBuyVolume - totalSellVolume;
  const buySellRatio = totalSellVolume > 0 ? totalBuyVolume / totalSellVolume : (totalBuyVolume > 0 ? 999 : 1);

  let intensity: "bullish" | "bearish" | "neutral";
  if (netFlow > totalVolume * 0.1) {
    intensity = "bullish";
  } else if (netFlow < -totalVolume * 0.1) {
    intensity = "bearish";
  } else {
    intensity = "neutral";
  }

  return {
    buyVolume: totalBuyVolume,
    sellVolume: totalSellVolume,
    netFlowUsd: netFlow,
    buySellRatio,
    intensity,
    smartMoneyNetFlow,
    smartMoneyBuyCount,
    smartMoneySellCount,
  };
}

function processKlineData(kline1mData: any[]) {
  // Format kline summaries
  const kline1mSummary = kline1mData.map((candle: any) => {
    return `O:${candle.open} H:${candle.high} L:${candle.low} C:${candle.close} V:${candle.volume}`;
  }).join("\n");

  // Parse current price from last 1m candle
  let currentPrice = 0;
  if (kline1mData.length > 0) {
    const lastCandle = kline1mData[kline1mData.length - 1];
    currentPrice = parseFloat(lastCandle.close) || 0;
  }

  // Calculate volume 5m and price change 5m from last 5 candles of 1m data
  let volume5m = 0;
  let priceChange5m = 0;

  const last5Candles = kline1mData.slice(-5);
  if (last5Candles.length >= 2) {
    const firstCandle = last5Candles[0];
    const lastCandle = last5Candles[last5Candles.length - 1];

    if (firstCandle && lastCandle) {
      // Calculate volume 5m
      volume5m = last5Candles.reduce((sum: number, candle: any) =>
        sum + (parseFloat(candle.volume) || 0), 0);

      // Calculate price change 5m
      const firstClose = parseFloat(firstCandle.close) || 0;
      const lastClose = parseFloat(lastCandle.close) || 0;
      if (firstClose > 0) {
        priceChange5m = ((lastClose - firstClose) / firstClose) * 100;
      }
    }
  }

  // Convert kline objects to number arrays for volume delta calculation
  const kline1mArray = kline1mData.map((candle: any) => [
    parseFloat(candle.open) || 0,
    parseFloat(candle.high) || 0,
    parseFloat(candle.low) || 0,
    parseFloat(candle.close) || 0,
    parseFloat(candle.volume) || 0,
  ]);

  // Calculate volume deltas (only 1m needed)
  const volumeDeltas1m = getVolumeDeltasFromKline(kline1mArray, 8);

  return { kline1mSummary, currentPrice, volume5m, priceChange5m, volumeDeltas1m };
}

function formatTradersSummary(traders: any[]): string {
  return traders.slice(0, 10).map((t: any) => {
    const walletName = t.name || t.address.slice(0, 6);
    const value = t.usd_value ? t.usd_value.toFixed(2) : "0";
    const side = t.netflow_usd > 0 ? "BUY" : (t.netflow_usd < 0 ? "SELL" : "HOLD");
    const netflow = t.netflow_usd ? `$${Math.abs(t.netflow_usd).toFixed(2)}` : "";
    const tags = t.tags && t.tags.length > 0 ? `[${t.tags.join(",")}]` : "";

    return `${walletName}: ${side} ${netflow} (Val: $${value}) ${tags}`;
  }).join("\n");
}
