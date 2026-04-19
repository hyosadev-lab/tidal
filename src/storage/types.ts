// Data Storage Schema (JSON)

export interface Trade {
  id: string;                    // UUID
  tokenAddress: string;
  tokenSymbol: string;
  tokenName: string;
  action: "BUY" | "SELL";
  inputAmount: string;           // amount dalam minimum unit
  inputAmountUsd: number;
  outputAmount: string;
  priceAtTrade: number;
  marketCapAtTrade: number;
  timestamp: number;             // Unix ms
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
  amountToken: string;           // jumlah token yang dipegang
  costUsd: number;               // total biaya dalam USD
  currentPrice?: number;         // update periodik
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
  insight: string;               // AI-generated insight
  pattern: {
    type: "entry" | "exit" | "filter" | "risk";
    description: string;
    successRate?: number;
    avgPnlPercent?: number;
  };
  appliedCount: number;          // berapa kali pattern ini dipakai
  successCount: number;          // berapa kali berhasil
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
  dailyStats: Record<string, {   // key: "YYYY-MM-DD"
    pnl: number;
    trades: number;
    wins: number;
  }>;
}

export interface TokenData {
  address: string;
  symbol: string;
  name: string;
  price: number;
  marketCap: number;
  liquidity: number;
  volume1h: number;
  volume24h: number;
  swaps1h: number;
  swaps24h: number;
  buys24h: number;
  sells24h: number;
  change1h: number;
  holderCount: number;
  smartDegenCount: number;
  renownedCount: number;
  top10HolderRate: number;
  creatorTokenStatus: string;
  creatorBalanceRate: number;
  rugRatio: number;
  bundlerRate: number;
  insiderRatio: number;
  isWashTrading: boolean;
  launchpadPlatform: string;
  renouncedMint: boolean;
  renouncedFreezeAccount: boolean;
  hasAtLeastOneSocial: boolean;
  ctoFlag: boolean;
  klineData: string;
  topTradersSummary: string;
}
