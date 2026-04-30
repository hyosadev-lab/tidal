import { getPerformance, getPositions, getLearnings, getDecisions } from "../storage/db";

async function showStats() {
  const [performance, positions, learnings, decisions] = await Promise.all([
    getPerformance(),
    getPositions(),
    getLearnings(),
    getDecisions(),
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
  console.log(`Avg Holding Minutes: ${(performance.avgHoldingHours * 60).toFixed(2)}`);
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
          `Entry MC: $${pos.entryMarketCap.toFixed(0)}, ` +
          `Current MC: $${(pos.currentMarketCap || 0).toFixed(0)}, ` +
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

  // Learning stats
  const totalDecisions = decisions.length;
  const completedDecisions = decisions.filter(d => d.outcome === "success" || d.outcome === "failure").length;
  const successfulDecisions = decisions.filter(d => d.outcome === "success").length;

  console.log("\n=== Learning System ===");
  console.log(`Total Decisions: ${totalDecisions}`);
  console.log(`Completed Decisions: ${completedDecisions} (${successfulDecisions} successful)`);
  console.log(`Learning Sets Generated: ${learnings.length}`);

  if (learnings.length > 0) {
    const totalPatterns = learnings.reduce((sum, l) => sum + l.patterns.length, 0);
    console.log(`Total Patterns Learned: ${totalPatterns}`);

    // Show pattern breakdown by type
    const patternTypes: Record<string, number> = {};
    learnings.forEach(l => {
      l.patterns.forEach(p => {
        patternTypes[p.type] = (patternTypes[p.type] || 0) + 1;
      });
    });
    console.log(`Pattern Types: ${Object.entries(patternTypes).map(([type, count]) => `${type}: ${count}`).join(", ")}`);

    // Show most recent learning
    const latestLearning = learnings[learnings.length - 1];
    if (latestLearning) {
      const ageMinutes = Math.floor((Date.now() - latestLearning.createdAt) / 60000);
      console.log(`Latest Learning: ${ageMinutes} minutes ago, ${latestLearning.patterns.length} patterns`);
    }
  }
  console.log("===========================\n");
}

showStats();
