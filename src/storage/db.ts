import type { Trade, Position, Learning, Performance, SoldToken } from "./types";

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
    totalPnlSol: 0,
    avgWinPercent: 0,
    avgLossPercent: 0,
    largestWinSol: 0,
    largestLossSol: 0,
    avgHoldingHours: 0,
    lastUpdated: Date.now(),
    dailyStats: {}
  });
}

export async function savePerformance(performance: Performance): Promise<void> {
  await writeJSON("performance.json", performance);
}

export async function updatePerformance(): Promise<void> {
  // Load all confirmed trades
  const trades = await getTrades();
  const confirmedTrades = trades.filter(t => t.orderStatus === "confirmed");

  // Total trades = all confirmed actions (Buy + Sell)
  const totalTrades = confirmedTrades.length;

  // Only SELL trades have realized PnL
  const completedSells = confirmedTrades.filter(t => t.action === "SELL" && t.pnlSol !== undefined);

  // Winning/Losing trades based on SELL actions
  const winningTrades = completedSells.filter(t => (t.pnlSol || 0) > 0).length;
  const losingTrades = completedSells.filter(t => (t.pnlSol || 0) < 0).length;

  // Win rate based on completed sells
  const winRate = (winningTrades + losingTrades) > 0
    ? winningTrades / (winningTrades + losingTrades)
    : 0;

  // Total PnL from all completed sells
  const totalPnlSol = completedSells.reduce((sum, t) => sum + (t.pnlSol || 0), 0);

  const winningPnLs = completedSells
    .filter(t => (t.pnlSol || 0) > 0)
    .map(t => t.pnlPercent || 0);
  const losingPnLs = completedSells
    .filter(t => (t.pnlSol || 0) < 0)
    .map(t => t.pnlPercent || 0);

  const avgWinPercent = winningPnLs.length > 0
    ? winningPnLs.reduce((a, b) => a + b, 0) / winningPnLs.length
    : 0;
  const avgLossPercent = losingPnLs.length > 0
    ? losingPnLs.reduce((a, b) => a + b, 0) / losingPnLs.length
    : 0;

  const pnlValues = completedSells.map(t => t.pnlSol || 0);
  const largestWinSol = pnlValues.length > 0 ? Math.max(...pnlValues) : 0;
  const largestLossSol = pnlValues.length > 0 ? Math.min(...pnlValues) : 0;

  // Avg holding hours based on completed sells (since they have holdingDurationMs)
  const totalHoldingMs = completedSells.reduce((sum, t) => sum + (t.holdingDurationMs || 0), 0);
  const avgHoldingHours = completedSells.length > 0 ? totalHoldingMs / completedSells.length / (1000 * 60 * 60) : 0;

  // Daily stats (based on all confirmed trades activity)
  const dailyStats: Record<string, { pnl: number; trades: number; wins: number }> = {};
  confirmedTrades.forEach(t => {
    const date = new Date(t.timestamp).toISOString().split("T")[0]!;
    if (!dailyStats[date]) {
      dailyStats[date] = { pnl: 0, trades: 0, wins: 0 };
    }
    dailyStats[date].trades += 1;
    // Only add PnL if it's a sell with realized PnL
    if (t.action === "SELL" && t.pnlSol !== undefined) {
        dailyStats[date].pnl += t.pnlSol;
        if (t.pnlSol > 0) dailyStats[date].wins += 1;
    }
  });

  const performance: Performance = {
    totalTrades,
    winningTrades,
    losingTrades,
    winRate,
    totalPnlSol,
    avgWinPercent,
    avgLossPercent,
    largestWinSol,
    largestLossSol,
    avgHoldingHours,
    lastUpdated: Date.now(),
    dailyStats,
  };

  await savePerformance(performance);
}

// Watchlist
export async function getWatchlist(): Promise<string[]> {
  return readJSON<string[]>("watchlist.json", []);
}

export async function saveWatchlist(watchlist: string[]): Promise<void> {
  await writeJSON("watchlist.json", watchlist);
}

// Recently Sold Tokens (cooldown)
export async function getSoldTokens(): Promise<SoldToken[]> {
  return readJSON<SoldToken[]>("sold_tokens.json", []);
}

export async function saveSoldTokens(tokens: SoldToken[]): Promise<void> {
  await writeJSON("sold_tokens.json", tokens);
}

export async function addSoldToken(token: { address: string; symbol: string }): Promise<void> {
  const soldTokens = await getSoldTokens();
  soldTokens.push({
    address: token.address,
    symbol: token.symbol,
    soldAt: Date.now(),
  });
  await saveSoldTokens(soldTokens);
}
