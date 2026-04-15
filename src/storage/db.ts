import fs from "fs";
import path from "path";
import type { StorageSchema, TokenInfo, CandlestickData, TrendingToken, ContractSecurity, TradeLog } from "../types";

// ============================================================
// STORAGE - Semua operasi baca/tulis ke file JSON
// ============================================================

const DATA_DIR = path.join(process.cwd(), "data");
const DB_FILE = path.join(DATA_DIR, "db.json");

const DEFAULT_DB: StorageSchema = {
  tokens: {},
  candlesticks: {},
  trending: [],
  security: {},
  tradeLogs: [],
  lastUpdated: new Date().toISOString(),
};

// Pastikan folder data dan file db.json ada
function ensureStorage(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify(DEFAULT_DB, null, 2));
    console.log("✅ Storage baru dibuat:", DB_FILE);
  }
}

// Baca seluruh database
function readDB(): StorageSchema {
  ensureStorage();
  const raw = fs.readFileSync(DB_FILE, "utf-8");
  return JSON.parse(raw) as StorageSchema;
}

// Tulis seluruh database
function writeDB(data: StorageSchema): void {
  ensureStorage();
  data.lastUpdated = new Date().toISOString();
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// ----- TOKEN -----
export function saveToken(token: TokenInfo): void {
  const db = readDB();
  db.tokens[token.address] = token;
  writeDB(db);
}

export function getToken(address: string): TokenInfo | null {
  const db = readDB();
  return db.tokens[address] ?? null;
}

export function getAllTokens(): TokenInfo[] {
  const db = readDB();
  return Object.values(db.tokens);
}

// ----- CANDLESTICK -----
export function saveCandlestick(data: CandlestickData): void {
  const db = readDB();
  const key = `${data.tokenAddress}_${data.resolution}`;
  db.candlesticks[key] = data;
  writeDB(db);
}

export function getCandlestick(tokenAddress: string, resolution: string): CandlestickData | null {
  const db = readDB();
  const key = `${tokenAddress}_${resolution}`;
  return db.candlesticks[key] ?? null;
}

// ----- TRENDING -----
export function saveTrending(tokens: TrendingToken[]): void {
  const db = readDB();
  db.trending = tokens;
  writeDB(db);
}

export function getTrending(): TrendingToken[] {
  const db = readDB();
  return db.trending;
}

// ----- SECURITY -----
export function saveSecurity(data: ContractSecurity): void {
  const db = readDB();
  db.security[data.tokenAddress] = data;
  writeDB(db);
}

export function getSecurity(tokenAddress: string): ContractSecurity | null {
  const db = readDB();
  return db.security[tokenAddress] ?? null;
}

// ----- TRADE LOGS -----
export function saveTradeLog(log: TradeLog): void {
  const db = readDB();
  // Update jika ID sudah ada, tambah baru jika belum
  const idx = db.tradeLogs.findIndex((l) => l.id === log.id);
  if (idx >= 0) {
    db.tradeLogs[idx] = log;
  } else {
    db.tradeLogs.push(log);
  }
  writeDB(db);
}

export function getTradeLogs(): TradeLog[] {
  const db = readDB();
  return db.tradeLogs;
}

export function getRecentTradeLogs(limit: number = 20): TradeLog[] {
  const db = readDB();
  return db.tradeLogs
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, limit);
}

// ----- UTILS -----
export function getDBStats(): object {
  const db = readDB();
  return {
    totalTokens: Object.keys(db.tokens).length,
    totalCandlesticks: Object.keys(db.candlesticks).length,
    totalTrendingTokens: db.trending.length,
    totalSecurityChecks: Object.keys(db.security).length,
    totalTradeLogs: db.tradeLogs.length,
    lastUpdated: db.lastUpdated,
  };
}
