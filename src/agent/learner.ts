import type { Trade, Learning } from "../storage/types";
import { getTrades, getLearnings, saveLearnings } from "../storage/db";
import { logger } from "../utils/logger";

async function getLastLearningTimestamp(): Promise<number> {
  const learnings = await getLearnings();
  if (learnings.length === 0) return 0;
  return Math.max(...learnings.map(l => l.createdAt));
}

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "openrouter/elephant-alpha";
const TEMPERATURE = parseFloat(process.env.TEMPERATURE || "0.3");
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || "5000", 10);

export async function generateLearnings(): Promise<void> {
  const trades = await getTrades();

  // Filter for confirmed trades
  const confirmedTrades = trades.filter((t) => t.orderStatus === "confirmed");

  // Check if we have enough new trades (e.g., 5 since last learning)
  if (confirmedTrades.length < 5) {
    logger.info("Not enough confirmed trades to generate learnings");
    return;
  }

  // Get learnings from last 20 trades, but only generate new ones every 10 trades
  const recentTrades = confirmedTrades.slice(-20);
  const lastLearning = await getLastLearningTimestamp();
  const tradesSinceLastLearning = confirmedTrades.filter(t => t.timestamp > lastLearning);

  if (tradesSinceLastLearning.length < 10) {
    logger.info(`Only ${tradesSinceLastLearning.length} trades since last learning, waiting for more...`);
    return;
  }

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
              content: `You are an expert ORDER FLOW TRADER analyzing trade history to identify patterns that improve win rate.
Your task is to analyze trades and identify order flow patterns that predict success or failure.

Key Analysis Areas:
1. ORDER FLOW ENTRY: When does bullish order flow lead to profitable buys?
2. ORDER FLOW EXIT: When does bearish order flow signal correct exits?
3. SMART MONEY PATTERNS: How do smart degen traders behave in winning vs losing trades?
4. VOLUME + ORDER FLOW: When do they align for real momentum vs traps?

Answer ONLY with valid JSON array: [{ type, description, successRate, avgPnlPercent }]`
            },
            { role: "user", content: prompt }
          ],
          response_format: { type: "json_object" },
          temperature: TEMPERATURE,
          max_tokens: MAX_TOKENS
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

  // Load existing learnings and save new ones (deduplicate)
  const existingLearnings = await getLearnings();

  // Deduplicate: keep only unique insights (based on description + type)
  const uniqueNewLearnings = newLearnings.filter((newLearning) => {
    const isDuplicate = existingLearnings.some(
      (existing) =>
        existing.pattern.type === newLearning.pattern.type &&
        existing.insight.toLowerCase() === newLearning.insight.toLowerCase()
    );
    return !isDuplicate;
  });

  // Keep only last 50 learnings to prevent bloat
  const maxLearnings = 50;
  const allLearnings = [...existingLearnings, ...uniqueNewLearnings];
  const trimmedLearnings = allLearnings.slice(-maxLearnings);

  await saveLearnings(trimmedLearnings);

  logger.info(`Generated ${uniqueNewLearnings.length} new unique learning(s), total: ${trimmedLearnings.length}`);
  uniqueNewLearnings.forEach((l) => logger.info(`Learning: ${l.insight}`));
}

function buildLearningPrompt(trades: Trade[]): string {
  const losingTrades = trades.filter((t) => (t.pnlPercent || 0) < 0);
  const winningTrades = trades.filter((t) => (t.pnlPercent || 0) > 0);

  const losingSummaries = losingTrades.map(t => `
    Token: ${t.tokenSymbol} (${t.tokenAddress})
    Entry Price: $${t.entryPrice || "N/A"}
    Exit Price: $${t.exitPrice || "N/A"}
    PnL: ${t.pnlPercent?.toFixed(2) || "N/A"}%
    PnL SOL: ${t.pnlSol?.toFixed(4) || "N/A"}
    Holding Duration: ${t.holdingDurationMs ? (t.holdingDurationMs / (1000 * 60 * 60)).toFixed(1) + "h" : "N/A"}
    Entry Reason: ${t.aiReasoning || "N/A"}
    Exit Reason: ${t.exitReason || "N/A"}
    Signals Used: ${t.signalsUsed ? t.signalsUsed.join(", ") : "N/A"}
  `).join("\n");

  const winningSummaries = winningTrades.map(t => `
    Token: ${t.tokenSymbol} (${t.tokenAddress})
    Entry Price: $${t.entryPrice || "N/A"}
    Exit Price: $${t.exitPrice || "N/A"}
    PnL: ${t.pnlPercent?.toFixed(2) || "N/A"}%
    PnL SOL: ${t.pnlSol?.toFixed(4) || "N/A"}
    Holding Duration: ${t.holdingDurationMs ? (t.holdingDurationMs / (1000 * 60 * 60)).toFixed(1) + "h" : "N/A"}
    Entry Reason: ${t.aiReasoning || "N/A"}
    Exit Reason: ${t.exitReason || "N/A"}
    Signals Used: ${t.signalsUsed ? t.signalsUsed.join(", ") : "N/A"}
  `).join("\n");

  const avgPnl = trades.reduce((sum, t) => sum + (t.pnlPercent || 0), 0) / trades.length;
  const wins = trades.filter((t) => (t.pnlPercent || 0) > 0).length;
  const winRate = (wins / trades.length * 100).toFixed(1);

  return `
Analyze the following trade history from a Solana memecoin trading bot using ORDER FLOW analysis.
Identify specific patterns that lead to successful trades (positive PnL) and failed trades (negative PnL).

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FOCUS AREAS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. ORDER FLOW ENTRY PATTERNS:
   - When is order flow bullish → BUY signal works?
   - When is order flow bearish → BUY signal fails?
   - Smart money accumulation patterns before pumps
   - Volume spike + order flow alignment vs trap

2. ORDER FLOW EXIT PATTERNS:
   - When is smart money selling → SELL signal works?
   - When is order flow turning bearish → exit timing?
   - Distribution patterns before dumps
   - Net flow negative signals

3. ORDER FLOW vs PRICE ACTION:
   - Does price follow order flow or lead it?
   - Bull trap patterns (volume up, order flow down)
   - Real momentum vs fake pumps

4. WINNING VS LOSING COMPARISON:
   - Order flow metrics in winning trades vs losing trades
   - Smart money behavior differences
   - Entry timing based on order flow intensity

Current Stats:
- Total Trades: ${trades.length}
- Win Rate: ${winRate}%
- Avg PnL: ${avgPnl.toFixed(2)}%
- Losing Trades: ${losingTrades.length}
- Winning Trades: ${winningTrades.length}

Losing Trades:
${losingSummaries || "None"}

Winning Trades:
${winningSummaries || "None"}

Generate 2-3 specific, actionable insights based on order flow patterns.
Format as JSON array: [{ type: "entry"|"exit"|"filter"|"risk", description: string, successRate: number, avgPnlPercent: number }]
  `;
}
