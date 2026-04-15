import fetch from "node-fetch";
import type { TokenInfo, CandlestickData, Candle, TrendingToken, ContractSecurity } from "../types";

// ============================================================
// GMGN API CLIENT - Semua komunikasi dengan GMGN API
// Dokumentasi: https://docs.gmgn.ai/index/gmgn-agent-api
// ============================================================

const BASE_URL = "https://gmgn.ai/api/v1";
const CHAIN = "sol"; // Solana

function getHeaders(): Record<string, string> {
  const apiKey = process.env.GMGN_API_KEY;
  if (!apiKey) {
    throw new Error("❌ GMGN_API_KEY tidak ditemukan! Tambahkan ke file .env");
  }
  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${apiKey}`,
  };
}

// Helper: fetch dengan error handling
async function gmgnFetch<T>(endpoint: string): Promise<T> {
  const url = `${BASE_URL}${endpoint}`;
  try {
    const res = await fetch(url, { headers: getHeaders() });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText} — ${url}`);
    }
    const json = await res.json() as { data: T };
    return json.data;
  } catch (err) {
    console.error(`❌ GMGN API Error [${endpoint}]:`, err);
    throw err;
  }
}

// ----- TOKEN INFO -----
export async function fetchTokenInfo(tokenAddress: string): Promise<TokenInfo> {
  console.log(`📡 Fetching token info: ${tokenAddress}`);
  const raw = await gmgnFetch<any>(`/token/${CHAIN}/${tokenAddress}`);

  return {
    address: tokenAddress,
    symbol: raw.symbol ?? "UNKNOWN",
    name: raw.name ?? "Unknown Token",
    price: parseFloat(raw.price ?? "0"),
    priceChange24h: parseFloat(raw.price_change_24h ?? "0"),
    volume24h: parseFloat(raw.volume_24h ?? "0"),
    liquidity: parseFloat(raw.liquidity ?? "0"),
    marketCap: parseFloat(raw.market_cap ?? "0"),
    fetchedAt: new Date().toISOString(),
  };
}

// ----- CANDLESTICK -----
export async function fetchCandlestick(
  tokenAddress: string,
  resolution: string = "5m",
  limit: number = 100
): Promise<CandlestickData> {
  console.log(`📈 Fetching candlestick ${resolution}: ${tokenAddress}`);
  const raw = await gmgnFetch<any[]>(
    `/token/${CHAIN}/${tokenAddress}/candlestick?resolution=${resolution}&limit=${limit}`
  );

  const candles: Candle[] = (raw ?? []).map((c: any) => ({
    timestamp: c.timestamp ?? c.time,
    open: parseFloat(c.open),
    high: parseFloat(c.high),
    low: parseFloat(c.low),
    close: parseFloat(c.close),
    volume: parseFloat(c.volume ?? "0"),
  }));

  return {
    tokenAddress,
    resolution,
    candles,
    fetchedAt: new Date().toISOString(),
  };
}

// ----- TRENDING TOKENS -----
export async function fetchTrendingTokens(limit: number = 20): Promise<TrendingToken[]> {
  console.log(`🔥 Fetching trending tokens (limit: ${limit})`);
  const raw = await gmgnFetch<any[]>(`/token/${CHAIN}/trending?limit=${limit}`);

  return (raw ?? []).map((t: any, idx: number) => ({
    address: t.address,
    symbol: t.symbol ?? "?",
    price: parseFloat(t.price ?? "0"),
    priceChange1h: parseFloat(t.price_change_1h ?? "0"),
    priceChange24h: parseFloat(t.price_change_24h ?? "0"),
    volume24h: parseFloat(t.volume_24h ?? "0"),
    rank: idx + 1,
    fetchedAt: new Date().toISOString(),
  }));
}

// ----- CONTRACT SECURITY -----
export async function fetchContractSecurity(tokenAddress: string): Promise<ContractSecurity> {
  console.log(`🛡️ Fetching security check: ${tokenAddress}`);
  const raw = await gmgnFetch<any>(`/token/${CHAIN}/${tokenAddress}/security`);

  const top10 = parseFloat(raw.top_10_holder_rate ?? "1") * 100;
  let riskLevel: ContractSecurity["riskLevel"] = "UNKNOWN";

  if (raw.is_honeypot || top10 > 80) {
    riskLevel = "HIGH";
  } else if (raw.has_blacklist || top10 > 50) {
    riskLevel = "MEDIUM";
  } else if (raw.liquidity_locked) {
    riskLevel = "LOW";
  }

  return {
    tokenAddress,
    isHoneypot: raw.is_honeypot ?? false,
    isMintable: raw.is_mintable ?? false,
    hasBlacklist: raw.has_blacklist ?? false,
    liquidityLocked: raw.liquidity_locked ?? false,
    top10HolderPercent: top10,
    riskLevel,
    fetchedAt: new Date().toISOString(),
  };
}

// ----- WALLET PORTFOLIO -----
export async function fetchWalletPortfolio(walletAddress: string): Promise<any> {
  console.log(`💰 Fetching portfolio: ${walletAddress}`);
  return await gmgnFetch<any>(`/wallet/${CHAIN}/${walletAddress}/portfolio`);
}
