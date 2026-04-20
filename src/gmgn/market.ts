import { fetchKline, fetchTopTraders } from "./client";

export async function getTokenDetails(chain: string, address: string) {
  try {
    // Fetch kline 1m (5 candles)
    const now = Math.floor(Date.now() / 1000);
    const from = now - 300; // 5 minutes ago
    const klineResult = await fetchKline(chain, address, "1m", from, now);
    const klineData = klineResult?.list || [];

    // Format kline data for AI context
    const klineSummary = klineData.map((candle: any) => {
      return `O:${candle.open} H:${candle.high} L:${candle.low} C:${candle.close} V:${candle.volume}`;
    }).join("\n");

    // Fetch top smart degens
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
      klineData: klineSummary,
      topTradersSummary: tradersSummary,
    };
  } catch (error) {
    console.error("Error fetching token details:", error);
    return {
      klineData: "",
      topTradersSummary: "",
    };
  }
}
