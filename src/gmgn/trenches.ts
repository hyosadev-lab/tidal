import { fetchTrenches } from "./client";
import type { TokenData } from "../storage/types";

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
  limit: 30,
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
    // Core fields
    address: item.address,
    symbol: item.symbol,
    name: item.name || item.symbol,
    usdMarketCap: parseFloat(item.usd_market_cap) || 0,
    liquidity: parseFloat(item.liquidity) || 0,
    volume24h: parseFloat(item.volume_24h) || 0,
    swaps24h: item.swaps_24h || 0,
    buys24h: item.buys_24h || 0,
    sells24h: item.sells_24h || 0,
    holderCount: item.holder_count || 0,
    smartDegenCount: item.smart_degen_count || 0,
    renownedCount: item.renowned_count || 0,
    top10HolderRate: parseFloat(item.top_10_holder_rate) || 0,
    creatorTokenStatus: item.creator_token_status || "",
    creatorBalanceRate: parseFloat(item.creator_balance_rate) || 0,
    rugRatio: parseFloat(item.rug_ratio) || 0,
    bundlerTraderAmountRate: parseFloat(item.bundler_trader_amount_rate) || 0,
    ratTraderAmountRate: parseFloat(item.rat_trader_amount_rate) || 0,
    isWashTrading: item.is_wash_trading || false,
    launchpadPlatform: item.launchpad_platform || "",
    renouncedMint: item.renounced_mint || false,
    renouncedFreezeAccount: item.renounced_freeze_account || false,
    hasAtLeastOneSocial: item.has_at_least_one_social || false,
    ctoFlag: item.cto_flag || false,
    // Additional fields from API
    bonusCategory: item.bonus_category,
    botDegenCount: item.bot_degen_count || 0,
    botDegenRate: item.bot_degen_rate || 0,
    bundlerMhr: item.bundler_mhr || 0,
    burnStatus: item.burn_status || "",
    buyTax: item.buy_tax || 0,
    buyTips: item.buy_tips || 0,
    chain: item.chain || "",
    completeCostTime: item.complete_cost_time || 0,
    completeTimestamp: item.complete_timestamp || 0,
    createdTimestamp: item.created_timestamp || 0,
    createdTimestampUs: item.created_timestamp_us || 0,
    creationTool: item.creation_tool || "",
    creator: item.creator || "",
    creatorCreatedCount: item.creator_created_count || 0,
    creatorCreatedOpenCount: item.creator_created_open_count || 0,
    creatorCreatedOpenRatio: item.creator_created_open_ratio || 0,
    devTeamHoldRate: item.dev_team_hold_rate || 0,
    devTokenBurnAmount: item.dev_token_burn_amount || 0,
    devTokenBurnRatio: item.dev_token_burn_ratio || 0,
    dexscrAd: item.dexscr_ad || false,
    dexscrBoostFee: item.dexscr_boost_fee || 0,
    dexscrTrendingBar: item.dexscr_trending_bar || false,
    dexscrUpdateLink: item.dexscr_update_link || false,
    endLiveTimestamp: item.end_live_timestamp || 0,
    entrapmentRatio: item.entrapment_ratio || 0,
    exchange: item.exchange || "",
    feeParams: item.fee_params || null,
    fracaster: item.fracaster || null,
    freshWalletRate: item.fresh_wallet_rate || 0,
    fundFrom: item.fund_from || "",
    fundFromTs: item.fund_from_ts || 0,
    imageDup: item.image_dup || 0,
    instagram: item.instagram || "",
    isHoneypot: item.is_honeypot || "",
    isTokenLive: item.is_token_live || false,
    launchpad: item.launchpad || "",
    logo: item.logo || "",
    marketCap: parseFloat(item.market_cap) || 0,
    netBuy24h: item.net_buy_24h || 0,
    newWalletVolume: item.new_wallet_volume || 0,
    offchain: item.offchain || false,
    openSource: item.open_source || "",
    openTimestamp: item.open_timestamp || 0,
    openTimestamp_us: item.open_timestamp_us || 0,
    ownerRenounced: item.owner_renounced || "",
    poolAddress: item.pool_address || "",
    priorityFee: item.priority_fee || 0,
    privateVaultHoldRate: item.private_vault_hold_rate || 0,
    progress: item.progress || 0,
    quoteAddress: item.quote_address || "",
    sellTax: item.sell_tax || 0,
    seqIndex: item.seq_index || "",
    showSharingFee: item.show_sharing_fee || false,
    sniperCount: item.sniper_count || 0,
    startLiveTimestamp: item.start_live_timestamp || 0,
    status: item.status || 0,
    suspectedInsiderHoldRate: item.suspected_insider_hold_rate || 0,
    tcName: item.tc_name || "",
    tcid: item.tcid || "",
    telegram: item.telegram || "",
    telegramDup: item.telegram_dup || 0,
    tgCallCount: item.tg_call_count || 0,
    tiktok: item.tiktok || "",
    tipFee: item.tip_fee || 0,
    top70SniperHoldRate: item.top70_sniper_hold_rate || 0,
    totalFee: item.total_fee || 0,
    totalSupply: item.total_supply || 0,
    tradeFee: item.trade_fee || 0,
    transName: item.trans_name || "",
    transNameZhcn: item.trans_name_zhcn || "",
    transSymbol: item.trans_symbol || "",
    transSymbolZhcn: item.trans_symbol_zhcn || "",
    twitter: item.twitter || "",
    twitterCreateTokenCount: item.twitter_create_token_count || 0,
    twitterDelPostTokenCount: item.twitter_del_post_token_count || 0,
    twitterDup: item.twitter_dup || 0,
    twitterHandle: item.twitter_handle || "",
    twitterIsTweet: item.twitter_is_tweet || false,
    twitterRenameCount: item.twitter_rename_count || 0,
    visitingCount: item.visiting_count || 0,
    website: item.website || "",
    websiteDup: item.website_dup || 0,
    xUserFollower: item.x_user_follower || 0,
    zoraSocialInfo: item.zora_social_info || null,
    // Enriched fields (will be filled later)
    kline1mData: "",
    kline5mData: "",
    topTradersSummary: "",
    price: 0, // Will be populated from kline data
    priceChange1h: 0, // Will be populated from kline data
  };
}
