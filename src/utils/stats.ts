import { getPerformance } from "../storage/db";

async function showStats() {
  const performance = await getPerformance();

  console.log("\n=== Trading Agent Stats ===");
  console.log(`Total Trades: ${performance.totalTrades}`);
  console.log(`Winning Trades: ${performance.winningTrades}`);
  console.log(`Losing Trades: ${performance.losingTrades}`);
  console.log(`Win Rate: ${(performance.winRate * 100).toFixed(2)}%`);
  console.log(`Total PnL: $${performance.totalPnlUsd.toFixed(2)}`);
  console.log(`Avg Win: ${performance.avgWinPercent.toFixed(2)}%`);
  console.log(`Avg Loss: ${performance.avgLossPercent.toFixed(2)}%`);
  console.log(`Largest Win: $${performance.largestWinUsd.toFixed(2)}`);
  console.log(`Largest Loss: $${performance.largestLossUsd.toFixed(2)}`);
  console.log(`Avg Holding Hours: ${performance.avgHoldingHours.toFixed(2)}`);
  console.log("===========================\n");
}

showStats();
