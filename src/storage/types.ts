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
  exitPrice?: number;
  pnlSol?: number;
  pnlPercent?: number;
  holdingDurationMs?: number;
  exitReason?:
    | "take_profit"
    | "stop_loss"
    | "ai_decision"
    | "manual"
    | "max_holding_time";

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
  kline1mData: string;
  kline5mData: string;
  price: number;
  priceChange5m: number;
  topTradersSummary: string;
  volume5m: number;
  volumeDeltas1m: string;
  volumeDeltas5m: string;
}

export interface SoldToken {
  address: string;
  symbol: string;
  soldAt: number;
}
