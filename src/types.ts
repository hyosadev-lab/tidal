// ============================================================
// TYPES - Semua definisi tipe data untuk sistem trading
// ============================================================

export interface TokenInfo {
  address: string;
  symbol: string;
  name: string;
  price: number;
  priceChange24h: number;
  volume24h: number;
  liquidity: number;
  marketCap: number;
  fetchedAt: string;
}

export interface CandlestickData {
  tokenAddress: string;
  resolution: string; // "1m" | "5m" | "15m" | "1h" | "4h" | "1d"
  candles: Candle[];
  fetchedAt: string;
}

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TrendingToken {
  address: string;
  symbol: string;
  price: number;
  priceChange1h: number;
  priceChange24h: number;
  volume24h: number;
  rank: number;
  fetchedAt: string;
}

export interface ContractSecurity {
  tokenAddress: string;
  isHoneypot: boolean;
  isMintable: boolean;
  hasBlacklist: boolean;
  liquidityLocked: boolean;
  top10HolderPercent: number;
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN";
  fetchedAt: string;
}

export interface TradeLog {
  id: string;
  timestamp: string;
  tokenAddress: string;
  tokenSymbol: string;
  action: "BUY" | "SELL" | "HOLD" | "SKIP";
  reason: string;
  amountSOL?: number;
  priceAtAction: number;
  aiAnalysis: string;
  riskCheckPassed: boolean;
  executed: boolean; // false = paper trade, true = live
  result?: TradeResult;
}

export interface TradeResult {
  exitPrice: number;
  exitTimestamp: string;
  pnlSOL: number;
  pnlPercent: number;
}

export interface StorageSchema {
  tokens: Record<string, TokenInfo>;
  candlesticks: Record<string, CandlestickData>;
  trending: TrendingToken[];
  security: Record<string, ContractSecurity>;
  tradeLogs: TradeLog[];
  lastUpdated: string;
}
