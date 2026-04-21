// Data Storage Schema (JSON)

export interface Trade {
  id: string; // UUID
  tokenAddress: string;
  tokenSymbol: string;
  tokenName: string;
  action: "BUY" | "SELL";
  inputAmount: string; // amount dalam minimum unit
  inputAmountUsd: number;
  outputAmount: string;
  priceAtTrade: number;
  marketCapAtTrade: number;
  timestamp: number; // Unix ms
  orderId: string;
  orderStatus: "pending" | "confirmed" | "failed" | "expired";
  txHash?: string;
  isDryRun: boolean;

  // Diisi saat SELL
  entryPrice?: number;
  exitPrice?: number;
  pnlUsd?: number;
  pnlPercent?: number;
  holdingDurationMs?: number;
  exitReason?: "take_profit" | "stop_loss" | "ai_decision" | "manual";

  // AI context saat decision
  aiReasoning?: string;
  signalsUsed?: string[];
}

export interface Position {
  tokenAddress: string;
  tokenSymbol: string;
  tokenName: string;
  entryPrice: number;
  entryMarketCap: number;
  entryTimestamp: number;
  amountToken: string; // jumlah token yang dipegang
  costUsd: number; // total biaya dalam USD
  currentPrice?: number; // update periodik
  currentMarketCap?: number;
  unrealizedPnlUsd?: number;
  unrealizedPnlPercent?: number;
  lastUpdated: number;
  buyTradeId: string;
}

export interface Learning {
  id: string;
  createdAt: number;
  basedOnTradeIds: string[];
  insight: string; // AI-generated insight
  pattern: {
    type: "entry" | "exit" | "filter" | "risk";
    description: string;
    successRate?: number;
    avgPnlPercent?: number;
  };
  appliedCount: number; // berapa kali pattern ini dipakai
  successCount: number; // berapa kali berhasil
}

export interface Performance {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalPnlUsd: number;
  avgWinPercent: number;
  avgLossPercent: number;
  largestWinUsd: number;
  largestLossUsd: number;
  avgHoldingHours: number;
  lastUpdated: number;
  dailyStats: Record<
    string,
    {
      // key: "YYYY-MM-DD"
      pnl: number;
      trades: number;
      wins: number;
    }
  >;
}

export interface TokenData {
  // Core Fields from gmgn-cli trenches
  address: string;
  bonusCategory: null;
  botDegenCount: number;
  botDegenRate: number;
  bundlerMhr: number;
  bundlerTraderAmountRate: number;
  burnStatus: string;
  buyTax: number;
  buyTips: number;
  buys24h: number;
  chain: string;
  completeCostTime: number;
  completeTimestamp: number;
  createdTimestamp: number;
  createdTimestampUs: number;
  creationTool: string;
  creator: string;
  creatorBalanceRate: number;
  creatorCreatedCount: number;
  creatorCreatedOpenCount: number;
  creatorCreatedOpenRatio: number;
  creatorTokenStatus: string;
  ctoFlag: boolean;
  devTeamHoldRate: number;
  devTokenBurnAmount: number;
  devTokenBurnRatio: number;
  dexscrAd: boolean;
  dexscrBoostFee: number;
  dexscrTrendingBar: boolean;
  dexscrUpdateLink: boolean;
  endLiveTimestamp: number;
  entrapmentRatio: number;
  exchange: string;
  feeParams: null;
  fracaster: null;
  freshWalletRate: number;
  fundFrom: string;
  fundFromTs: number;
  hasAtLeastOneSocial: boolean;
  holderCount: number;
  imageDup: number;
  instagram: string;
  isHoneypot: string;
  isTokenLive: boolean;
  isWashTrading: boolean;
  launchpad: string;
  launchpadPlatform: string;
  liquidity: number;
  logo: string;
  marketCap: number;
  name: string;
  netBuy24h: number;
  newWalletVolume: number;
  offchain: boolean;
  openSource: string;
  openTimestamp: number;
  openTimestamp_us: number;
  ownerRenounced: string;
  poolAddress: string;
  priorityFee: number;
  privateVaultHoldRate: number;
  progress: number;
  quoteAddress: string;
  ratTraderAmountRate: number;
  renouncedFreezeAccount: boolean;
  renouncedMint: boolean;
  renownedCount: number;
  rugRatio: number;
  sellTax: number;
  sells24h: number;
  seqIndex: string;
  showSharingFee: boolean;
  smartDegenCount: number;
  sniperCount: number;
  startLiveTimestamp: number;
  status: number;
  suspectedInsiderHoldRate: number;
  swaps24h: number;
  symbol: string;
  tcName: string;
  tcid: string;
  telegram: string;
  telegramDup: number;
  tgCallCount: number;
  tiktok: string;
  tipFee: number;
  top70SniperHoldRate: number;
  top10HolderRate: number;
  totalFee: number;
  totalSupply: number;
  tradeFee: number;
  transName: string;
  transNameZhcn: string;
  transSymbol: string;
  transSymbolZhcn: string;
  twitter: string;
  twitterCreateTokenCount: number;
  twitterDelPostTokenCount: number;
  twitterDup: number;
  twitterHandle: string;
  twitterIsTweet: boolean;
  twitterRenameCount: number;
  usdMarketCap: number;
  visitingCount: number;
  volume24h: number;
  website: string;
  websiteDup: number;
  xUserFollower: number;
  zoraSocialInfo: null;

  // Enriched Fields from gmgn-cli market kline and gmgn-cli token traders
  kline1mData: string;
  kline5mData: string;
  topTradersSummary: string;
  price: number;
  priceChange1h: number;
}
