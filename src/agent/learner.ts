import type { Trade, Learning } from "../storage/types";
import { getTrades, getLearnings, saveLearnings } from "../storage/db";
import { logger } from "../utils/logger";

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "openrouter/elephant-alpha";

export async function generateLearnings(): Promise<void> {
  const trades = await getTrades();

  // Filter for confirmed trades
  const confirmedTrades = trades.filter((t) => t.orderStatus === "confirmed");

  // Check if we have enough new trades (e.g., 5 since last learning)
  if (confirmedTrades.length < 5) {
    logger.info("Not enough confirmed trades to generate learnings");
    return;
  }

  const recentTrades = confirmedTrades.slice(-20); // Last 20 trades

  logger.info("Generating learnings from recent trades");

  let newLearnings: Learning[] = [];

  if (OPENROUTER_API_KEY) {
    try {
      const prompt = buildLearningPrompt(recentTrades);

      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
          "HTTP-Referer": "https://github.com/trading-agent",
          "X-Title": "Trenches Trading Agent"
        },
        body: JSON.stringify({
          model: OPENROUTER_MODEL,
          messages: [
            {
              role: "system",
              content: "You are an expert crypto trader analyzing trade history to identify patterns that improve win rate. Analyze the trades below and generate 2-3 specific insights. Format as JSON array: [{ type, description, successRate, avgPnlPercent }]"
            },
            { role: "user", content: prompt }
          ],
          response_format: { type: "json_object" },
          temperature: 0.3,
          max_tokens: 1000
        })
      });

      if (response.ok) {
        const data = await response.json() as any;
        const content = data.choices?.[0]?.message?.content;

        if (content) {
          const insights = JSON.parse(content);
          newLearnings = insights.map((insight: any) => ({
            id: crypto.randomUUID(),
            createdAt: Date.now(),
            basedOnTradeIds: recentTrades.map((t) => t.id),
            insight: insight.description,
            pattern: {
              type: insight.type || "entry",
              description: insight.description,
              successRate: insight.successRate || 0,
              avgPnlPercent: insight.avgPnlPercent || 0,
            },
            appliedCount: 0,
            successCount: 0,
          }));
        }
      }
    } catch (error) {
      logger.error("Error calling OpenRouter for learnings", { error: String(error) });
    }
  }

  // Fallback: Generate simple learning if OpenRouter fails or not configured
  if (newLearnings.length === 0) {
    const wins = recentTrades.filter((t) => (t.pnlPercent || 0) > 0).length;
    const avgPnl = recentTrades.reduce((sum, t) => sum + (t.pnlPercent || 0), 0) / recentTrades.length;

    newLearnings = [{
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
    }];
  }

  // Load existing learnings and save new ones
  const existingLearnings = await getLearnings();
  const updatedLearnings = [...existingLearnings, ...newLearnings];
  await saveLearnings(updatedLearnings);

  logger.info(`Generated ${newLearnings.length} new learning(s)`);
  newLearnings.forEach((l) => logger.info(`Learning: ${l.insight}`));
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
