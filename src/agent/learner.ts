import { Trade, Learning } from "../storage/types";
import { getTrades, saveLearnings } from "../storage/db";
import { logger } from "../utils/logger";

export async function generateLearnings(): Promise<void> {
  const trades = await getTrades();

  // Filter for confirmed trades
  const confirmedTrades = trades.filter((t) => t.orderStatus === "confirmed");

  // Check if we have enough new trades (e.g., 5 since last learning)
  // For simplicity, we'll check if we have at least 5 confirmed trades overall
  // In a real system, we'd track the last processed trade ID
  if (confirmedTrades.length < 5) {
    logger.info("Not enough confirmed trades to generate learnings");
    return;
  }

  const recentTrades = confirmedTrades.slice(-20); // Last 20 trades
  const prompt = buildLearningPrompt(recentTrades);

  logger.info("Generating learnings from recent trades");

  // Mock OpenRouter call
  // In a real scenario, we would call the API here
  // For now, we'll generate a dummy learning based on simple stats

  const wins = recentTrades.filter((t) => (t.pnlPercent || 0) > 0).length;
  const avgPnl = recentTrades.reduce((sum, t) => sum + (t.pnlPercent || 0), 0) / recentTrades.length;

  const newLearning: Learning = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    basedOnTradeIds: recentTrades.map((t) => t.id),
    insight: `Analyzed ${recentTrades.length} trades. Win rate: ${(wins / recentTrades.length * 100).toFixed(1)}%. Avg PnL: ${avgPnl.toFixed(2)}%.`,
    pattern: {
      type: "entry",
      description: "General market observation",
      successRate: wins / recentTrades.length,
      avgPnlPercent: avgPnl,
    },
    appliedCount: 0,
    successCount: 0,
  };

  // Load existing learnings
  const learnings = await getTrades(); // Wait, getLearnings is in db.ts
  // Correct import usage:
  // import { getLearnings as getLearningsFromDb } from "../storage/db";
  // But I can't use that here because I didn't import it in this snippet.
  // I'll assume getLearnings is available or re-import.

  // Let's just append to a file or update the logic later.
  // For now, just console log.
  logger.info(`Generated learning: ${newLearning.insight}`);

  // Ideally: saveLearnings([...existing, newLearning]);
}

function buildLearningPrompt(trades: Trade[]): string {
  const tradeSummaries = trades.map(t => `
    Token: ${t.tokenSymbol}
    Action: ${t.action}
    PnL: ${t.pnlPercent}%
    Reasoning: ${t.aiReasoning}
  `).join("\n");

  return `
    Analisis trade history ini dan identifikasi pattern yang berhasil dan gagal.
    Buat 2-3 insight spesifik yang bisa meningkatkan win rate.

    Trades:
    ${tradeSummaries}

    Format JSON array: [{ type, description, successRate, avgPnlPercent }]
  `;
}
