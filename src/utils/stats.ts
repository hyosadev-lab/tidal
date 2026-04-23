import { getPerformance, getPositions } from "../storage/db";

async function showStats() {
  const [performance, positions] = await Promise.all([
    getPerformance(),
    getPositions(),
  ]);

  console.log("\n=== Trading Agent Stats ===");
  console.log(`Total Trades: ${performance.totalTrades}`);
  console.log(`Winning Trades: ${performance.winningTrades}`);
  console.log(`Losing Trades: ${performance.losingTrades}`);
  console.log(`Win Rate: ${(performance.winRate * 100).toFixed(2)}%`);
  console.log(`Total PnL (Realized): $${performance.totalPnlUsd.toFixed(2)}`);
  console.log(`Avg Win: ${performance.avgWinPercent.toFixed(2)}%`);
  console.log(`Avg Loss: ${performance.avgLossPercent.toFixed(2)}%`);
  console.log(`Largest Win: $${performance.largestWinUsd.toFixed(2)}`);
  console.log(`Largest Loss: $${performance.largestLossUsd.toFixed(2)}`);
  console.log(`Avg Holding Hours: ${performance.avgHoldingHours.toFixed(2)}`);
  console.log("===========================\n");

  let totalUnrealizedPnl = 0;

  console.log("\n=== Open Positions ===");
  if (positions.length === 0) {
    console.log("No open positions.");
  } else {
    positions.forEach((pos) => {
      const pnl = pos.unrealizedPnlUsd || 0;
      totalUnrealizedPnl += pnl;
      console.log(
        `${pos.tokenSymbol} (${pos.tokenAddress.slice(0, 6)}...): ` +
          `Entry: $${pos.entryPrice.toFixed(4)}, ` +
          `Current: $${(pos.currentPrice || 0).toFixed(4)}, ` +
          `PnL: $${pnl.toFixed(2)} (${(pos.unrealizedPnlPercent || 0).toFixed(2)}%)`,
      );
    });
    console.log(`Total Unrealized PnL: $${totalUnrealizedPnl.toFixed(2)}`);
  }
  console.log("===========================\n");

  console.log("\n=== Portfolio Summary ===");
  const totalEquity = performance.totalPnlUsd + totalUnrealizedPnl;
  console.log(`Realized PnL: $${performance.totalPnlUsd.toFixed(2)}`);
  console.log(`Unrealized PnL: $${totalUnrealizedPnl.toFixed(2)}`);
  console.log(`Total Equity Change: $${totalEquity.toFixed(2)}`);
  console.log("===========================\n");
}

showStats();
