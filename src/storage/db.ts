import type { Trade, Position, Learning, Performance } from "./types";

const DATA_DIR = "data";

function getPath(filename: string) {
  return `${DATA_DIR}/${filename}`;
}

async function readJSON<T>(filename: string, defaultValue: T): Promise<T> {
  try {
    const file = Bun.file(getPath(filename));
    if (await file.exists()) {
      return (await file.json()) as T;
    }
  } catch (error) {
    console.error(`Error reading ${filename}:`, error);
  }
  return defaultValue;
}

async function writeJSON<T>(filename: string, data: T): Promise<void> {
  try {
    await Bun.write(getPath(filename), JSON.stringify(data, null, 2));
  } catch (error) {
    console.error(`Error writing ${filename}:`, error);
  }
}

// Trades
export async function getTrades(): Promise<Trade[]> {
  return readJSON<Trade[]>("trades.json", []);
}

export async function saveTrades(trades: Trade[]): Promise<void> {
  await writeJSON("trades.json", trades);
}

// Positions
export async function getPositions(): Promise<Position[]> {
  return readJSON<Position[]>("positions.json", []);
}

export async function savePositions(positions: Position[]): Promise<void> {
  await writeJSON("positions.json", positions);
}

// Learnings
export async function getLearnings(): Promise<Learning[]> {
  return readJSON<Learning[]>("learnings.json", []);
}

export async function saveLearnings(learnings: Learning[]): Promise<void> {
  await writeJSON("learnings.json", learnings);
}

// Performance
export async function getPerformance(): Promise<Performance> {
  return readJSON<Performance>("performance.json", {
    totalTrades: 0,
    winningTrades: 0,
    losingTrades: 0,
    winRate: 0,
    totalPnlUsd: 0,
    avgWinPercent: 0,
    avgLossPercent: 0,
    largestWinUsd: 0,
    largestLossUsd: 0,
    avgHoldingHours: 0,
    lastUpdated: Date.now(),
    dailyStats: {}
  });
}

export async function savePerformance(performance: Performance): Promise<void> {
  await writeJSON("performance.json", performance);
}

// Watchlist
export async function getWatchlist(): Promise<string[]> {
  return readJSON<string[]>("watchlist.json", []);
}

export async function saveWatchlist(watchlist: string[]): Promise<void> {
  await writeJSON("watchlist.json", watchlist);
}
