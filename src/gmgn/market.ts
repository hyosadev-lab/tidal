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
    const tradersSummary = traders.map((t: any) => {
      return `${t.maker_info?.name || t.maker.slice(0, 6)}: ${t.side} $${t.amount_usd}`;
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
