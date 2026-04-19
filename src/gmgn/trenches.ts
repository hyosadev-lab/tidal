import { fetchTrenches } from "./client";
import { TokenData } from "../storage/types";

// Filters from CLAUDE.md
const FILTERS = {
  filterPreset: "safe",
  minSmartDegenCount: 1,
  minMarketCap: 20000,
  maxMarketCap: 2000000,
  maxRugRatio: 0.3,
  maxBundlerRate: 0.3,
  maxInsiderRatio: 0.3,
  sortBy: "smart_degen_count",
  limit: 50,
};

export async function fetchTrenchesTokens(chain: string = "sol"): Promise<TokenData[]> {
  try {
    const result = await fetchTrenches(chain, FILTERS);

    // The response structure depends on gmgn-cli version, but usually contains arrays
    // CLAUDE.md mentions: data.new_creation[], data.pump[], data.completed[]
    // We need to combine these categories

    const tokens: any[] = [];

    if (result.new_creation) tokens.push(...result.new_creation);
    if (result.pump) tokens.push(...result.pump);
    if (result.completed) tokens.push(...result.completed);

    return tokens.map(mapToTokenData);
  } catch (error) {
    console.error("Error fetching trenches:", error);
    return [];
  }
}

function mapToTokenData(item: any): TokenData {
  // Map the API response fields to our TokenData interface
  return {
    address: item.address,
    symbol: item.symbol,
    name: item.name || item.symbol,
    price: parseFloat(item.price) || 0,
    marketCap: parseFloat(item.usd_market_cap) || 0,
    liquidity: parseFloat(item.liquidity) || 0,
    volume1h: parseFloat(item.volume_1h) || 0,
    volume24h: parseFloat(item.volume_24h) || 0,
    swaps1h: item.swaps_1h || 0,
    swaps24h: item.swaps_24h || 0,
    buys24h: item.buys_24h || 0,
    sells24h: item.sells_24h || 0,
    change1h: parseFloat(item.price_change_percent1h) || 0,
    holderCount: item.holder_count || 0,
    smartDegenCount: item.smart_degen_count || 0,
    renownedCount: item.renowned_count || 0,
    top10HolderRate: parseFloat(item.top_10_holder_rate) || 0,
    creatorTokenStatus: item.creator_token_status || "",
    creatorBalanceRate: parseFloat(item.creator_balance_rate) || 0,
    rugRatio: parseFloat(item.rug_ratio) || 0,
    bundlerRate: parseFloat(item.bundler_rate) || 0,
    insiderRatio: parseFloat(item.rat_trader_amount_rate) || 0,
    isWashTrading: item.is_wash_trading || false,
    launchpadPlatform: item.launchpad_platform || "",
    renouncedMint: item.renounced_mint || false,
    renouncedFreezeAccount: item.renounced_freeze_account || false,
    hasAtLeastOneSocial: item.has_at_least_one_social || false,
    ctoFlag: item.cto_flag || false,
    klineData: "", // To be filled later
    topTradersSummary: "", // To be filled later
  };
}
