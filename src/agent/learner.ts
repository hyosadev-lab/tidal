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
              content: "You are an expert crypto trader analyzing trade history to identify patterns that improve win rate. Analyze the trades below and generate 2-3 specific insights. Answer ONLY with valid JSON array: [{ type, description, successRate, avgPnlPercent }]"
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
          try {
            // Parse the JSON response
            const parsed = typeof content === 'string' ? JSON.parse(content) : content;
            // Handle both array and object with insights property
            const insights = Array.isArray(parsed) ? parsed : (parsed.insights || []);

            if (insights && Array.isArray(insights)) {
              newLearnings = insights.map((insight: any) => {
                // Calculate success count based on the pattern type and recent trades
                const relevantTrades = recentTrades.filter((t) => {
                  // Simple heuristic: match based on PnL direction
                  if (insight.type === "entry") {
                    return true; // All trades are relevant for entry patterns
                  } else if (insight.type === "exit") {
                    return t.exitReason !== undefined;
                  }
                  return true;
                });

                const successfulTrades = relevantTrades.filter((t) => (t.pnlPercent || 0) > 0);
                const successCount = successfulTrades.length;
                const appliedCount = relevantTrades.length;

                return {
                  id: crypto.randomUUID(),
                  createdAt: Date.now(),
                  basedOnTradeIds: recentTrades.map((t) => t.id),
                  insight: insight.description || "No description provided",
                  pattern: {
                    type: insight.type || "entry",
                    description: insight.description || "No description provided",
                    successRate: insight.successRate || (appliedCount > 0 ? successCount / appliedCount : 0),
                    avgPnlPercent: insight.avgPnlPercent || 0,
                  },
                  appliedCount: appliedCount,
                  successCount: successCount,
                };
              });
            }
          } catch (parseError) {
            logger.error("Error parsing OpenRouter response", { error: String(parseError), content });
          }
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
    const winRate = recentTrades.length > 0 ? wins / recentTrades.length : 0;

    // Generate specific insights based on actual trade performance
    let insights: string[] = [];

    if (winRate > 0.6 && avgPnl > 0) {
      insights.push(`Current strategy is working. Win rate ${(winRate * 100).toFixed(1)}%, avg PnL ${avgPnl.toFixed(2)}%. Continue current approach.`);
    } else if (winRate < 0.4 || avgPnl < 0) {
      insights.push(`Current strategy needs adjustment. Win rate ${(winRate * 100).toFixed(1)}%, avg PnL ${avgPnl.toFixed(2)}%. Review entry/exit criteria.`);
    } else {
      insights.push(`Strategy performance is neutral. Win rate ${(winRate * 100).toFixed(1)}%, avg PnL ${avgPnl.toFixed(2)}%. Monitor for patterns.`);
    }

    // Add insight about holding duration if available
    const avgHoldingMs = recentTrades.reduce((sum, t) => sum + (t.holdingDurationMs || 0), 0) / recentTrades.length;
    const avgHoldingHours = avgHoldingMs / (1000 * 60 * 60);
    if (avgHoldingHours > 24) {
      insights.push(`Trades held for avg ${avgHoldingHours.toFixed(1)}h. Consider shorter holds for faster capital rotation.`);
    } else if (avgHoldingHours < 1) {
      insights.push(`Trades held for avg ${avgHoldingHours.toFixed(1)}h. Ensure not selling too early on small moves.`);
    }

    newLearnings = insights.map((insight) => ({
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      basedOnTradeIds: recentTrades.map((t) => t.id),
      insight: insight,
      pattern: {
        type: "filter", // Use 'filter' for general strategy insights
        description: insight,
        successRate: winRate,
        avgPnlPercent: avgPnl,
      },
      appliedCount: recentTrades.length,
      successCount: wins,
    }));
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
    Token: ${t.tokenSymbol} (${t.tokenAddress})
    Action: ${t.action}
    Entry Price: $${t.entryPrice || "N/A"}
    Exit Price: $${t.exitPrice || "N/A"}
    PnL: ${t.pnlPercent?.toFixed(2) || "N/A"}%
    PnL USD: $${t.pnlUsd?.toFixed(2) || "N/A"}
    Holding Duration: ${t.holdingDurationMs ? (t.holdingDurationMs / (1000 * 60 * 60)).toFixed(1) + "h" : "N/A"}
    Entry Reason: ${t.aiReasoning || "N/A"}
    Exit Reason: ${t.exitReason || "N/A"}
  `).join("\n");

  const avgPnl = trades.reduce((sum, t) => sum + (t.pnlPercent || 0), 0) / trades.length;
  const wins = trades.filter((t) => (t.pnlPercent || 0) > 0).length;
  const winRate = (wins / trades.length * 100).toFixed(1);

  return `
Analyze the following trade history from a Solana memecoin trading bot.
Identify specific patterns that lead to successful trades (positive PnL) and failed trades (negative PnL).
Focus on:
1. Entry criteria that worked well
2. Exit criteria that worked well
3. Risk management patterns
4. Token characteristics (market cap, liquidity, smart degen count) associated with wins/losses

Current Stats:
- Total Trades: ${trades.length}
- Win Rate: ${winRate}%
- Avg PnL: ${avgPnl.toFixed(2)}%

Trades:
${tradeSummaries}

Generate 2-3 specific, actionable insights.
Format as JSON array: [{ type: "entry"|"exit"|"filter"|"risk", description: string, successRate: number, avgPnlPercent: number }]
  `;
}
