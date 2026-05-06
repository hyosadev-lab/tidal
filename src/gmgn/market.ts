import { fetchKline, fetchTopTraders, fetchTokenInfo, fetchTokenSecurity } from "./client";
import { getVolumeDeltasFromKline, getCandlePatterns, getCVDProxy, getVolumeProfile } from "../utils/kline";

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
  priceChange1h: number;
  volume1h: number;
  volumeDeltas1m: string;
  // On-chain flow derived signals
  candlePatterns: string;
  cvdProxy: string;
  volumeProfile: string;
  // Token Info fields (real-time data)
  liquidity: number;
  holderCount: number;
  smartDegenCount: number; // total smart wallets on token
  activeSmartDegenCount: number; // smart degens in top traders list
  renownedCount: number;
  usdMarketCap: number;
  launchpadPlatform: string;
  creatorTokenStatus: string;
  top10HolderRate: number;
  creatorBalanceRate: number;
  // Token Security fields
  rugRatio: number;
  isWashTrading: boolean;
  bundlerTraderAmountRate: number;
  ratTraderAmountRate: number;
  renouncedMint: boolean;
  renouncedFreezeAccount: boolean;
  hasAtLeastOneSocial: boolean;
  ctoFlag: boolean;
  // Additional holder quality fields
  sniperCount: number;
  freshWalletRate: number;
  privateVaultHoldRate: number;
  devTeamHoldRate: number;
  insiderHoldRate: number;
  tokenAgeSecs: number;
}

export async function getTokenDetails(chain: string, address: string): Promise<TokenDetails> {
  try {
    const now = Math.floor(Date.now() / 1000);
    const from1m = now - 1800; // 30 minutes ago for 30 candles of 1m data

    // Step 1: Fetch core data (info & security) sequential with rate limit
    const tokenInfo = await fetchTokenInfo(chain, address);
    const tokenSecurity = await fetchTokenSecurity(chain, address);

    // Step 2: Fetch market data (kline & traders) sequential with rate limit
    const tradersResult = await fetchTopTraders(chain, address, 100);
    const kline1mResult = await fetchKline(chain, address, "1m", from1m, now);

    const traders = tradersResult?.list || [];
    const kline1mData = kline1mResult?.list || [];

    // Calculate Order Flow (reuse traders data)
    const orderFlowSummary = calculateOrderFlow(traders);

    // Get REAL-TIME price from token info (more accurate than kline)
    const currentPrice = parseFloat(tokenInfo.price) || 0;

    // Process K-line Data for volume and price change analysis only
    const { kline1mSummary, volume1h, priceChange1h, volumeDeltas1m } = processKlineData(kline1mData, currentPrice);

    // Convert kline objects to number arrays for derived signal calculation
    const kline1mArray = kline1mData.map((candle: any) => [
      parseFloat(candle.open) || 0,
      parseFloat(candle.high) || 0,
      parseFloat(candle.low) || 0,
      parseFloat(candle.close) || 0,
      parseFloat(candle.volume) || 0,
    ]);

    // Derive on-chain flow signals from 1m candles
    const candlePatterns = getCandlePatterns(kline1mArray);
    const cvdProxy = getCVDProxy(kline1mArray);
    const volumeProfile = getVolumeProfile(kline1mArray);

    // Process Traders Summary
    const tradersSummary = formatTradersSummary(traders);
    const activeSmartDegenCount = traders.filter((t: any) => t.tags?.includes("smart_degen")).length;

    // Extract additional holder quality fields from already-fetched data
    const sniperCount = parseInt(tokenSecurity.sniper_count) || 0;
    const freshWalletRate = parseFloat(tokenInfo.stat?.fresh_wallet_rate) || 0;
    const privateVaultHoldRate = parseFloat(tokenInfo.stat?.private_vault_hold_rate) || 0;
    const devTeamHoldRate = parseFloat(tokenInfo.stat?.dev_team_hold_rate) || 0;
    const insiderHoldRate = parseFloat(tokenInfo.stat?.top_rat_trader_percentage) || 0;
    const tokenAgeSecs = tokenInfo.creation_timestamp
      ? now - parseInt(tokenInfo.creation_timestamp)
      : 0;

    return {
      kline1mData: kline1mSummary,
      topTradersSummary: tradersSummary,
      orderFlowSummary,
      price: currentPrice,
      priceChange1h: priceChange1h,
      volume1h: volume1h,
      volumeDeltas1m,
      candlePatterns,
      cvdProxy,
      volumeProfile,
      // Token Info fields
      liquidity: parseFloat(tokenInfo.liquidity) || 0,
      holderCount: tokenInfo.holder_count || 0,
      smartDegenCount: tokenInfo.wallet_tags_stat?.smart_wallets || 0,
      activeSmartDegenCount,
      renownedCount: tokenInfo.wallet_tags_stat?.renowned_wallets || 0,
      usdMarketCap: parseFloat(tokenInfo.price) * parseFloat(tokenInfo.circulating_supply) || 0,
      launchpadPlatform: tokenInfo.launchpad_platform || "",
      creatorTokenStatus: tokenSecurity.creator_token_status === "creator_close" ? "creator_close" : "creator_hold",
      top10HolderRate: parseFloat(tokenInfo.stat?.top_10_holder_rate) || 0,
      creatorBalanceRate: parseFloat(tokenInfo.stat?.creator_hold_rate) || 0,
      // Token Security fields
      rugRatio: parseFloat(tokenSecurity.rug_ratio) || 0,
      isWashTrading: tokenSecurity.is_wash_trading || false,
      bundlerTraderAmountRate: parseFloat(tokenSecurity.bundler_trader_amount_rate) || 0,
      ratTraderAmountRate: parseFloat(tokenSecurity.rat_trader_amount_rate) || 0,
      renouncedMint: tokenSecurity.renounced_mint || false,
      renouncedFreezeAccount: tokenSecurity.renounced_freeze_account || false,
      hasAtLeastOneSocial: tokenSecurity.has_at_least_one_social || false,
      ctoFlag: tokenSecurity.cto_flag || false,
      // Additional holder quality fields
      sniperCount,
      freshWalletRate,
      privateVaultHoldRate,
      devTeamHoldRate,
      insiderHoldRate,
      tokenAgeSecs,
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
      priceChange1h: 0,
      volume1h: 0,
      volumeDeltas1m: "",
      candlePatterns: "",
      cvdProxy: "",
      volumeProfile: "",
      liquidity: 0,
      holderCount: 0,
      smartDegenCount: 0,
      activeSmartDegenCount: 0,
      renownedCount: 0,
      usdMarketCap: 0,
      launchpadPlatform: "",
      creatorTokenStatus: "",
      top10HolderRate: 0,
      creatorBalanceRate: 0,
      rugRatio: 0,
      isWashTrading: false,
      bundlerTraderAmountRate: 0,
      ratTraderAmountRate: 0,
      renouncedMint: false,
      renouncedFreezeAccount: false,
      hasAtLeastOneSocial: false,
      ctoFlag: false,
      sniperCount: 0,
      freshWalletRate: 0,
      privateVaultHoldRate: 0,
      devTeamHoldRate: 0,
      insiderHoldRate: 0,
      tokenAgeSecs: 0,
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

function processKlineData(kline1mData: any[], realTimePrice: number) {
  // Format kline summaries with LATEST marker on last candle
  const kline1mSummary = kline1mData.map((candle: any, index: number) => {
    const isLatest = index === kline1mData.length - 1;
    return `O:${candle.open} H:${candle.high} L:${candle.low} C:${candle.close} V:${candle.volume}${isLatest ? " ← LATEST" : ""}`;
  }).join("\n");

  // Calculate volume 1h and price change 1h from last 12 candles of 1m data (12 minutes)
  let volume1h = 0;
  let priceChange1h = 0;

  const last12Candles = kline1mData.slice(-12);
  if (last12Candles.length >= 2) {
    const firstCandle = last12Candles[0];
    const lastCandle = last12Candles[last12Candles.length - 1];

    if (firstCandle && lastCandle) {
      // Calculate volume 1h (sum of last 12 candles = 12 minutes)
      volume1h = last12Candles.reduce((sum: number, candle: any) =>
        sum + (parseFloat(candle.volume) || 0), 0);

      // Calculate price change 1h based on first candle close vs REAL-TIME price
      const firstClose = parseFloat(firstCandle.close) || 0;
      if (firstClose > 0 && realTimePrice > 0) {
        priceChange1h = ((realTimePrice - firstClose) / firstClose) * 100;
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

  // Calculate volume deltas on 1m data (last 6 candles)
  const volumeDeltas1m = getVolumeDeltasFromKline(kline1mArray, 15);

  return { kline1mSummary, volume1h, priceChange1h, volumeDeltas1m };
}

function formatTradersSummary(traders: any[]): string {
  return traders.filter(t => t.tags?.includes("smart_degen")).map((t: any) => {
    const walletName = t.name || t.address.slice(0, 6);
    const value = t.usd_value ? t.usd_value.toFixed(2) : "0";
    const side = t.netflow_usd > 0 ? "BUY" : (t.netflow_usd < 0 ? "SELL" : "HOLD");
    const netflow = t.netflow_usd ? `$${Math.abs(t.netflow_usd).toFixed(2)}` : "";
    const tags = t.tags && t.tags.length > 0 ? `[${t.tags.join(",")}]` : "";

    return `${walletName}: ${side} ${netflow} (Val: $${value}) ${tags}`;
  }).join("\n");
}
