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
  // HOLD decision tracking
  lastHoldDecisionId?: string; // Reference to most recent HOLD decision
}

export interface PatternAnalysis {
  type: "entry" | "exit" | "risk" | "filter" | "timing" | "volume" | "hold_loss" | "missed_opportunity";
  description: string;
  successRate: number;
  avgPnlPercent: number;
  appliedCount: number;
  successCount: number;
  // Pattern metadata for weighting
  recencyWeight?: number;
  confidence?: number;
  examples?: string[]; // Token addresses that matched this pattern
}

export interface LearningScore {
  patternId: string;
  score: number; // Weighted score for this pattern
  reason: string;
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
  // For HOLD decisions - link to eventual SELL
  linkedDecisionId?: string;
  holdOutcome?: "profit" | "loss" | "breakeven" | "uncertain";
}

export interface DecisionContext {
  // Token data snapshot at decision time
  priceAtTrade?: number;
  marketCapAtTrade?: number;
  inputAmountSol?: number;
  inputAmount?: string;
  outputAmount?: string;
  entryPrice?: number;
  exitPrice?: number;
  isDryRun?: boolean;
  // Market conditions at decision time
  orderFlowIntensity?: "bullish" | "bearish" | "neutral";
  volume1h?: number;
  smartDegenCount?: number;
  rugRatio?: number;
  liquidity?: number;
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
  context?: DecisionContext; // Rich context for learning
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

  // Enriched Fields from gmgn-cli market kline and gmgn-cli token traders
  kline5mData: string;
  price: number;
  priceChange1h: number;
  topTradersSummary: string;
  usdMarketCap: number;
  volume1h: number;
  volumeDeltas5m: string;
  orderFlowSummary: OrderFlowSummary;
}

export interface SoldToken {
  address: string;
  symbol: string;
  soldAt: number;
}
