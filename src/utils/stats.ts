import { getPerformance, getPositions } from "../storage/db";

async function showStats() {
  const [performance, positions] = await Promise.all([
    getPerformance(),
    getPositions(),
  ]);

  console.log("\n=== Trading Agent Stats ===");
  console.log(`Realized Trades: ${performance.totalTrades}`);
  console.log(`Winning Trades: ${performance.winningTrades}`);
  console.log(`Losing Trades: ${performance.losingTrades}`);
  console.log(`Win Rate: ${(performance.winRate * 100).toFixed(2)}%`);
  console.log(`Total PnL (Realized): ${performance.totalPnlSol.toFixed(4)} SOL`);
  console.log(`Avg Win: ${performance.avgWinPercent.toFixed(2)}%`);
  console.log(`Avg Loss: ${performance.avgLossPercent.toFixed(2)}%`);
  console.log(`Largest Win: ${performance.largestWinSol.toFixed(4)} SOL`);
  console.log(`Largest Loss: ${performance.largestLossSol.toFixed(4)} SOL`);
  console.log(`Avg Holding Hours: ${performance.avgHoldingHours.toFixed(2)}`);
  console.log("===========================\n");

  let totalUnrealizedPnl = 0;

  console.log("\n=== Open Positions ===");
  if (positions.length === 0) {
    console.log("No open positions.");
  } else {
    positions.forEach((pos) => {
      totalUnrealizedPnl += pos.unrealizedPnlSol || 0;
      console.log(
        `${pos.tokenSymbol} (${pos.tokenAddress.slice(0, 6)}...): ` +
          `Entry: ${pos.entryPrice.toFixed(6)} SOL, ` +
          `Current: ${(pos.currentPrice || 0).toFixed(6)} SOL, ` +
          `PnL: ${(pos.unrealizedPnlSol || 0).toFixed(4)} SOL (${(pos.unrealizedPnlPercent || 0).toFixed(2)}%)`,
      );
    });
    console.log(`Total Unrealized PnL: ${totalUnrealizedPnl.toFixed(4)} SOL`);
  }
  console.log("===========================\n");

  console.log("\n=== Portfolio Summary ===");
  const totalEquity = performance.totalPnlSol + totalUnrealizedPnl;
  console.log(`Realized PnL: ${performance.totalPnlSol.toFixed(4)} SOL`);
  console.log(`Unrealized PnL: ${totalUnrealizedPnl.toFixed(4)} SOL`);
  console.log(`Total Equity Change: ${totalEquity.toFixed(4)} SOL`);
  console.log("===========================\n");
}

showStats();
