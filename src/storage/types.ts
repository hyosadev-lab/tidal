// Data Storage Schema (JSON)

export interface Trade {
  id: string; // UUID
  tokenAddress: string;
  tokenSymbol: string;
  tokenName: string;
  action: "BUY" | "SELL";
  inputAmount: string; // amount dalam minimum unit
  inputAmountSol: number;
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
  entryMarketCap?: number;
  exitPrice?: number;
  exitMarketCap?: number;
  pnlSol?: number;
  pnlPercent?: number;
  holdingDurationMs?: number;
  exitReason?: string;

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
  costSol: number; // total biaya dalam SOL
  currentPrice?: number; // update periodik
  currentMarketCap?: number;
  unrealizedPnlSol?: number;
  unrealizedPnlPercent?: number;
  lastUpdated: number;
  buyTradeId: string;
  // Data saat entry untuk perbandingan
  smartDegenEntryCount?: number;
  // Trailing stop data
  peakPrice?: number;
  peakPriceTimestamp?: number;
}

export interface PatternAnalysis {
  type: "entry" | "exit" | "risk" | "filter";
  description: string;
  successRate: number;
  avgPnlPercent: number;
  appliedCount: number;
  successCount: number;
}

export interface LearningResponse {
  patterns: PatternAnalysis[];
  insights: string;
}

export interface Learning {
  id: string;
  createdAt: number;
  basedOnTradeIds: string[];
  patterns: PatternAnalysis[];
  insights: string;
}

export interface DecisionOutcomeDetails {
  pnlSol?: number;
  pnlPercent?: number;
  exitReason?: string;
  holdingDurationMs?: number;
  orderId?: string;
  orderStatus?: string;
  txHash?: string;
  error?: string;
}

export interface DecisionRecord {
  id: string; // UUID
  tokenAddress: string;
  tokenSymbol: string;
  decisionType: "BUY" | "SELL" | "HOLD" | "SKIP";
  timestamp: number; // Unix ms
  confidence: number; // 0-100
  reasoning: string;
  signals: string[];
  outcome: "success" | "failure" | "pending" | "executed" | "skipped";
  outcomeDetails?: DecisionOutcomeDetails;
  aiReasoning?: string;
}

export interface Performance {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalPnlSol: number;
  avgWinPercent: number;
  avgLossPercent: number;
  largestWinSol: number;
  largestLossSol: number;
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

export interface TokenData {
  // Core Fields from gmgn-cli trenches
  address: string;
  bundlerTraderAmountRate: number;
  creatorBalanceRate: number;
  creatorTokenStatus: string;
  ctoFlag: boolean;
  hasAtLeastOneSocial: boolean;
  holderCount: number;
  isWashTrading: boolean;
  launchpadPlatform: string;
  liquidity: number;
  name: string;
  ratTraderAmountRate: number;
  renouncedFreezeAccount: boolean;
  renouncedMint: boolean;
  renownedCount: number;
  rugRatio: number;
  smartDegenCount: number;
  symbol: string;
  top10HolderRate: number;
  usdMarketCap: number;

  // Enriched Fields from gmgn-cli market kline and gmgn-cli token traders
  kline5mData: string;
  price: number;
  priceChange1h: number;
  topTradersSummary: string;
  volume1h: number;
  volumeDeltas5m: string;
  orderFlowSummary: OrderFlowSummary;
}

export interface SoldToken {
  address: string;
  symbol: string;
  soldAt: number;
}
