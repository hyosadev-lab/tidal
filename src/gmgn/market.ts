import { fetchKline, fetchTopTraders, fetchTokenInfo, fetchTokenSecurity } from "./client";
import { delay } from "../utils/concurrency";
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

export interface TokenDetails {
  kline1mData: string;
  kline5mData: string;
  topTradersSummary: string;
  price: number;
  priceChange5m: number;
  volume5m: number;
  volumeDeltas1m: string;
  volumeDeltas5m: string;
}

export async function getTokenDetails(chain: string, address: string): Promise<TokenDetails> {
  try {
    const now = Math.floor(Date.now() / 1000);

    // 1. Fetch top smart degens (first to avoid rate limit blocking other calls)
    const tradersResult = await fetchTopTraders(chain, address, "smart_degen", 10);
    const traders = tradersResult?.list || [];

    // Format traders summary
    const tradersSummary = traders.map((t: any) => {
      const walletName = t.name || t.address.slice(0, 6);
      const value = t.usd_value ? t.usd_value.toFixed(2) : "0";
      const side = t.netflow_usd > 0 ? "BUY" : (t.netflow_usd < 0 ? "SELL" : "HOLD");
      const netflow = t.netflow_usd ? `$${Math.abs(t.netflow_usd).toFixed(2)}` : "";
      const tags = t.tags && t.tags.length > 0 ? `[${t.tags.join(",")}]` : "";

      return `${walletName}: ${side} ${netflow} (Val: $${value}) ${tags}`;
    }).join("\n");

    // Delay between API calls to avoid rate limit
    await delay(500); // 500ms delay

    // 2. Fetch kline 5m (12 candles = 60 minutes)
    const from5m = now - 3600; // 60 minutes ago
    const kline5mResult = await fetchKline(chain, address, "5m", from5m, now);
    const kline5mData = kline5mResult?.list || [];

    const kline5mSummary = kline5mData.map((candle: any) => {
      return `O:${candle.open} H:${candle.high} L:${candle.low} C:${candle.close} V:${candle.volume}`;
    }).join("\n");

    // Delay between API calls to avoid rate limit
    await delay(500); // 500ms delay

    // 3. Fetch kline 1m (30 candles = 30 minutes)
    const from1m = now - 1800; // 30 minutes ago
    const kline1mResult = await fetchKline(chain, address, "1m", from1m, now);
    const kline1mData = kline1mResult?.list || [];

    const kline1mSummary = kline1mData.map((candle: any) => {
      return `O:${candle.open} H:${candle.high} L:${candle.low} C:${candle.close} V:${candle.volume}`;
    }).join("\n");

    // Parse current price from last 1m candle
    let currentPrice = 0;
    const klineLines = kline1mSummary.split("\n").filter((line: string) => line.trim());

    if (klineLines.length > 0) {
      const lastCandle = klineLines[klineLines.length - 1] ?? "";
      const closeMatch = lastCandle.match(/C:([0-9.]+)/);
      if (closeMatch) {
        currentPrice = parseFloat(closeMatch[1] ?? "") || 0;
      }
    }

    // Calculate volume 5m and price change 5m from last 5 candles of 1m data
    let volume5m = 0;
    let priceChange5m = 0;

    // Use last 5 candles from 1m data for 5m metrics
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
    // format: [open, high, low, close, volume]
    const kline1mArray = kline1mData.map((candle: any) => [
      parseFloat(candle.open) || 0,
      parseFloat(candle.high) || 0,
      parseFloat(candle.low) || 0,
      parseFloat(candle.close) || 0,
      parseFloat(candle.volume) || 0,
    ]);

    const kline5mArray = kline5mData.map((candle: any) => [
      parseFloat(candle.open) || 0,
      parseFloat(candle.high) || 0,
      parseFloat(candle.low) || 0,
      parseFloat(candle.close) || 0,
      parseFloat(candle.volume) || 0,
    ]);

    // Calculate volume deltas using converted arrays
    const volumeDeltas1m = getVolumeDeltasFromKline(kline1mArray, 8);
    const volumeDeltas5m = getVolumeDeltasFromKline(kline5mArray, 4);

    return {
      kline1mData: kline1mSummary,
      kline5mData: kline5mSummary,
      topTradersSummary: tradersSummary,
      price: currentPrice,
      priceChange5m: priceChange5m,
      volume5m: volume5m,
      volumeDeltas1m: volumeDeltas1m,
      volumeDeltas5m: volumeDeltas5m,
    };
  } catch (error) {
    console.error("Error fetching token details:", error);
    return {
      kline1mData: "",
      kline5mData: "",
      topTradersSummary: "",
      price: 0,
      priceChange5m: 0,
      volume5m: 0,
      volumeDeltas1m: "",
      volumeDeltas5m: "",
    };
  }
}
