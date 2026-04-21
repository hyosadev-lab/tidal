import { fetchKline, fetchTopTraders } from "./client";
import { delay } from "../utils/concurrency";

export async function getTokenDetails(chain: string, address: string) {
  try {
    const now = Math.floor(Date.now() / 1000);

    // 1. Fetch kline 1m (30 candles = 30 minutes)
    const from1m = now - 1800; // 30 minutes ago
    const kline1mResult = await fetchKline(chain, address, "1m", from1m, now);
    const kline1mData = kline1mResult?.list || [];

    const kline1mSummary = kline1mData.map((candle: any) => {
      return `O:${candle.open} H:${candle.high} L:${candle.low} C:${candle.close} V:${candle.volume}`;
    }).join("\n");

    // Parse price and price change from kline summary
    let currentPrice = 0;
    let priceChange1h = 0;
    const klineLines = kline1mSummary.split("\n").filter((line: string) => line.trim());

    if (klineLines.length > 0) {
      const lastCandle = klineLines[klineLines.length - 1] ?? "";
      const closeMatch = lastCandle.match(/C:([0-9.]+)/);
      if (closeMatch) {
        currentPrice = parseFloat(closeMatch[1] ?? "") || 0;
      }

      if (klineLines.length >= 2) {
        const firstCandle = klineLines[0] ?? "";
        const firstCloseMatch = firstCandle.match(/C:([0-9.]+)/);

        if (firstCloseMatch && closeMatch) {
          const firstClose = parseFloat(firstCloseMatch[1] ?? "") || 0;
          const lastClose = parseFloat(closeMatch[1] ?? "") || 0;

          if (firstClose > 0) {
            priceChange1h = ((lastClose - firstClose) / firstClose) * 100;
          }
        }
      }
    }

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

    // 3. Fetch top smart degens
    const tradersResult = await fetchTopTraders(chain, address, "smart_degen", 10);
    const traders = tradersResult?.list || [];

    // Format traders summary
    // Note: 'token traders' response structure is different from market token_top_traders
    // It has 'address', 'name', 'usd_value', 'netflow_usd', 'tags'
    const tradersSummary = traders.map((t: any) => {
      const walletName = t.name || t.address.slice(0, 6);
      const value = t.usd_value ? t.usd_value.toFixed(2) : "0";
      // Determine side based on netflow if available, or just show value
      const side = t.netflow_usd > 0 ? "BUY" : (t.netflow_usd < 0 ? "SELL" : "HOLD");
      const netflow = t.netflow_usd ? `$${Math.abs(t.netflow_usd).toFixed(2)}` : "";
      const tags = t.tags && t.tags.length > 0 ? `[${t.tags.join(",")}]` : "";

      return `${walletName}: ${side} ${netflow} (Val: $${value}) ${tags}`;
    }).join("\n");

    return {
      kline1mData: kline1mSummary,
      kline5mData: kline5mSummary,
      topTradersSummary: tradersSummary,
      price: currentPrice,
      priceChange1h: priceChange1h,
    };
  } catch (error) {
    console.error("Error fetching token details:", error);
    return {
      kline1mData: "",
      kline5mData: "",
      topTradersSummary: "",
      price: 0,
      priceChange1h: 0,
    };
  }
}
