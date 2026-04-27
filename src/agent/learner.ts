import type { Trade, Learning } from "../storage/types";
import { getTrades, saveLearnings, getLearnings } from "../storage/db";
import { logger } from "../utils/logger";

let lastLearningsCount = 0;

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "openrouter/elephant-alpha";
const TEMPERATURE = parseFloat(process.env.TEMPERATURE || "0.3");
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || "5000", 10);

const SYSTEM_PROMPT = `
You are a trading strategy analyst for Solana memecoin "Trenches" trading.

Analyze completed trades and extract actionable patterns to improve future
BUY/SKIP and HOLD/SELL decisions. Focus on Order Flow signals — smart money
activity, buy/sell pressure, and volume delta.

Respond ONLY in JSON:
{
  "patterns": [
    {
      "type": "entry" | "exit" | "risk" | "filter",
      "description": "concise, actionable pattern",
      "successRate": 0-100,
      "avgPnlPercent": number,
      "appliedCount": number,
      "successCount": number
    }
  ],
  "insights": "1-2 sentences summary"
}
`;

interface PatternAnalysis {
  type: "entry" | "exit" | "risk" | "filter";
  description: string;
  successRate: number;
  avgPnlPercent: number;
  appliedCount: number;
  successCount: number;
}

interface LearningResponse {
  patterns: PatternAnalysis[];
  insights: string;
}

/**
 * Generate new learning insights from recent trades
 * Called every 5 completed trades
 */
export async function generateLearnings(): Promise<void> {
  try {
    const allTrades = await getTrades();

    // Get only confirmed trades (completed)
    const confirmedTrades = allTrades.filter(
      (t) => t.orderStatus === "confirmed",
    );

    // Generate learnings only when count increases by multiples of 10
    // e.g., if last count was 0 and now 10, generate. If 10 and still 10, don't generate.
    const currentCount = confirmedTrades.length;
    const shouldGenerate =
      currentCount > 0 &&
      currentCount % 10 === 0 &&
      currentCount > lastLearningsCount;

    if (!shouldGenerate) return;

    logger.info(`Generating learnings for ${currentCount} confirmed trades`);
    lastLearningsCount = currentCount;

    // Get last 20 trades for analysis
    const recentTrades = confirmedTrades.slice(-20);

    // Calculate statistics
    const stats = calculateStats(recentTrades);

    // Call OpenRouter for pattern analysis
    const patterns = await analyzeWithAI(recentTrades, stats);

    if (patterns.length === 0) {
      logger.warn("No patterns generated from AI analysis");
      return;
    }

    // Convert to Learning format
    const newLearnings: Learning[] = patterns.map((pattern, index) => ({
      id: `learning_${Date.now()}_${index}`,
      createdAt: Date.now(),
      basedOnTradeIds: recentTrades.slice(-5).map((t) => t.id),
      insight: generateInsightText(pattern),
      pattern: {
        type: pattern.type,
        description: pattern.description,
        successRate: pattern.successRate,
        avgPnlPercent: pattern.avgPnlPercent,
        appliedCount: pattern.appliedCount,
        successCount: pattern.successCount,
      },
    }));

    // Save learnings
    await saveLearnings(newLearnings);

    // Cleanup old learnings (older than 7 days)
    const allLearnings = await getLearnings();
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recentLearnings = allLearnings.filter(l => l.createdAt > sevenDaysAgo);

    if (recentLearnings.length < allLearnings.length) {
      await saveLearnings(recentLearnings);
      logger.info(`Cleaned up ${allLearnings.length - recentLearnings.length} old learnings (older than 7 days)`);
    }

    logger.info(
      `Generated ${newLearnings.length} new learning patterns from ${recentTrades.length} trades (total ${currentCount} confirmed trades)`,
    );

    // Log insights for review
    const insightsSummary = patterns
      .map(
        (p) =>
          `[${p.type.toUpperCase()}] ${p.description} (${p.successRate}% success, ${p.avgPnlPercent > 0 ? "+" : ""}${p.avgPnlPercent}% avg PnL)`,
      )
      .join("\n");

    logger.info(`Learning Insights:\n${insightsSummary}`);
  } catch (error) {
    logger.error("Error generating learnings", { error: String(error) });
  }
}

/**
 * Analyze trades and extract patterns
 */
async function analyzeWithAI(
  trades: Trade[],
  stats: any,
): Promise<PatternAnalysis[]> {
  if (!OPENROUTER_API_KEY) {
    logger.warn("OPENROUTER_API_KEY not set, using fallback pattern analysis");
    return fallbackPatternAnalysis(trades);
  }

  try {
    const userMessage = buildAnalysisPrompt(trades, stats);

    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          "HTTP-Referer": "https://github.com/hyosadev-lab/tidal",
          "X-Title": "TIDAL · Autonomous Trading Agent",
        },
        body: JSON.stringify({
          model: OPENROUTER_MODEL,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userMessage },
          ],
          response_format: { type: "json_object" },
          temperature: TEMPERATURE,
          max_tokens: MAX_TOKENS,
        }),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      logger.error("OpenRouter API error", {
        status: response.status,
        error: errorText,
      });
      return fallbackPatternAnalysis(trades);
    }

    const data = (await response.json()) as any;
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      logger.error("Invalid OpenRouter response format", { data });
      return fallbackPatternAnalysis(trades);
    }

    const parsed = JSON.parse(content) as LearningResponse;
    return parsed.patterns || [];
  } catch (error) {
    logger.error("Error calling OpenRouter", { error: String(error) });
    return fallbackPatternAnalysis(trades);
  }
}

/**
 * Fallback: Rule-based pattern extraction when AI fails
 */
function fallbackPatternAnalysis(trades: Trade[]): PatternAnalysis[] {
  const patterns: PatternAnalysis[] = [];

  // Analyze entry patterns
  const winningBuys = trades.filter((t) => {
    const sellTrade = trades.find(
      (s) => s.tokenAddress === t.tokenAddress && s.action === "SELL",
    );
    return sellTrade && sellTrade.pnlSol && sellTrade.pnlSol > 0;
  });

  const losingBuys = trades.filter((t) => {
    const sellTrade = trades.find(
      (s) => s.tokenAddress === t.tokenAddress && s.action === "SELL",
    );
    return sellTrade && sellTrade.pnlSol && sellTrade.pnlSol < 0;
  });

  // Entry pattern: Smart money presence
  if (winningBuys.length >= 2) {
    const avgSmartDegenWin =
      winningBuys.reduce((sum, t) => {
        const signals = t.signalsUsed || [];
        return sum + (signals.includes("smart_money") ? 1 : 0);
      }, 0) / winningBuys.length;

    patterns.push({
      type: "entry",
      description: "Smart degen traders present at entry",
      successRate: Math.round((avgSmartDegenWin / 1) * 100),
      avgPnlPercent: calculateAvgPnl(winningBuys),
      appliedCount: winningBuys.length,
      successCount: winningBuys.length,
    });
  }

  // Risk pattern: High rug ratio
  const rugRatioLosses = losingBuys.filter((t) => {
    // This would need security data saved during trade
    // For now, use signals if available
    const signals = t.signalsUsed || [];
    return signals.includes("high_risk");
  });

  if (rugRatioLosses.length > 0) {
    patterns.push({
      type: "risk",
      description: "High risk metrics (rug ratio, wash trading)",
      successRate: 0,
      avgPnlPercent: calculateAvgPnl(losingBuys),
      appliedCount: rugRatioLosses.length,
      successCount: 0,
    });
  }

  // Exit pattern: Quick profit taking
  const quickWins = winningBuys.filter((t) => {
    const sellTrade = trades.find(
      (s) => s.tokenAddress === t.tokenAddress && s.action === "SELL",
    );
    if (!sellTrade || !sellTrade.holdingDurationMs) return false;
    // Less than 10 minutes
    return sellTrade.holdingDurationMs < 10 * 60 * 1000;
  });

  if (quickWins.length > 0) {
    patterns.push({
      type: "exit",
      description: "Quick exit (under 10 min) on strong pumps preserves profit",
      successRate:
        Math.round((quickWins.length / winningBuys.length) * 100) || 100,
      avgPnlPercent: calculateAvgPnl(quickWins),
      appliedCount: quickWins.length,
      successCount: quickWins.length,
    });
  }

  // Filter pattern: Skip if no smart money
  const noSmartMoneyBuys = trades.filter((t) => {
    const signals = t.signalsUsed || [];
    return !signals.includes("smart_money") && t.action === "BUY";
  });

  const noSmartMoneyWins = noSmartMoneyBuys.filter((t) => {
    const sellTrade = trades.find(
      (s) => s.tokenAddress === t.tokenAddress && s.action === "SELL",
    );
    return sellTrade && sellTrade.pnlSol && sellTrade.pnlSol > 0;
  });

  if (noSmartMoneyBuys.length >= 3) {
    patterns.push({
      type: "filter",
      description: "Skip tokens without smart degen participation",
      successRate: Math.round(
        (noSmartMoneyWins.length / noSmartMoneyBuys.length) * 100,
      ),
      avgPnlPercent: calculateAvgPnl(
        noSmartMoneyBuys.filter((t) => {
          const sellTrade = trades.find(
            (s) => s.tokenAddress === t.tokenAddress && s.action === "SELL",
          );
          return sellTrade;
        }),
      ),
      appliedCount: noSmartMoneyBuys.length,
      successCount: noSmartMoneyWins.length,
    });
  }

  return patterns;
}

/**
 * Build analysis prompt from trades
 */
function buildAnalysisPrompt(trades: Trade[], stats: any): string {
  const tradeDetails = trades
    .map((t) => {
      const isWin = t.pnlPercent && t.pnlPercent > 0;
      const status = t.action === "SELL"
        ? (isWin ? "WIN" : "LOSS")
        : "BUY";

      return `
[${status}] ${t.tokenSymbol}
Action: ${t.action} | Status: ${t.orderStatus}
Price: $${t.priceAtTrade.toFixed(8)} | MC: $${Math.round(t.marketCapAtTrade).toLocaleString()}
${t.action === "SELL" ? `Entry: $${t.entryPrice?.toFixed(8)} | Exit: $${t.exitPrice?.toFixed(8)}
PnL: ${t.pnlPercent?.toFixed(2)}% (${t.pnlSol?.toFixed(4)} SOL)
Hold: ${t.holdingDurationMs ? (t.holdingDurationMs / 60000).toFixed(1) + "m" : "N/A"}
Exit Reason: ${t.exitReason ?? "N/A"}` : ""}
Signals: ${t.signalsUsed?.join(", ") || "None"}
AI Reasoning: ${t.aiReasoning || "N/A"}
`;
    })
    .join("\n---\n");

  return `
Analyze these ${trades.length} completed trades and extract Order Flow patterns.
Focus on: smart money activity, buy/sell pressure, volume delta, and entry/exit timing.

Stats:
- Total: ${stats.totalTrades} | Win Rate: ${stats.winRate.toFixed(1)}% | Avg PnL: ${stats.avgPnl.toFixed(4)} SOL | Avg Hold: ${stats.avgHoldingMinutes.toFixed(1)}m
- Wins: ${stats.wins} | Losses: ${stats.losses}

Trades:
${tradeDetails}
`;
}

/**
 * Calculate statistics from trades
 */
function calculateStats(trades: Trade[]) {
  const sellTrades = trades.filter((t) => t.action === "SELL");
  const wins = sellTrades.filter((t) => t.pnlSol && t.pnlSol > 0);
  const losses = sellTrades.filter((t) => t.pnlSol && t.pnlSol < 0);

  const totalPnl = sellTrades.reduce((sum, t) => sum + (t.pnlSol || 0), 0);
  const avgPnl = sellTrades.length > 0 ? totalPnl / sellTrades.length : 0;
  const avgHolding =
    sellTrades.length > 0
      ? sellTrades.reduce((sum, t) => sum + (t.holdingDurationMs || 0), 0) /
        sellTrades.length /
        60000
      : 0;

  return {
    totalTrades: trades.length,
    winRate:
      sellTrades.length > 0 ? (wins.length / sellTrades.length) * 100 : 0,
    avgPnl: avgPnl,
    avgHoldingMinutes: avgHolding,
    wins: wins.length,
    losses: losses.length,
  };
}

/**
 * Calculate average PnL from trades
 */
function calculateAvgPnl(trades: Trade[]): number {
  const sellTrades = trades.filter(
    (t) => t.action === "SELL" && t.pnlPercent !== undefined,
  );
  if (sellTrades.length === 0) return 0;

  const sum = sellTrades.reduce((acc, t) => acc + (t.pnlPercent || 0), 0);
  return sum / sellTrades.length;
}

/**
 * Generate human-readable insight text from pattern
 */
function generateInsightText(pattern: PatternAnalysis): string {
  const successText =
    pattern.successRate >= 60
      ? "HIGH SUCCESS"
      : pattern.successRate >= 40
        ? "MODERATE"
        : "LOW SUCCESS";

  switch (pattern.type) {
    case "entry":
      return `[ENTRY] ${pattern.description} → ${successText} (${pattern.avgPnlPercent > 0 ? "+" : ""}${pattern.avgPnlPercent}% avg)`;
    case "exit":
      return `[EXIT] ${pattern.description} → ${successText} (avg ${pattern.avgPnlPercent > 0 ? "+" : ""}${pattern.avgPnlPercent}%)`;
    case "risk":
      return `[RISK] ${pattern.description} → AVOID (${pattern.successRate}% success, avg ${pattern.avgPnlPercent}%)`;
    case "filter":
      return `[FILTER] ${pattern.description} → ${successText} (${pattern.successRate}% success rate)`;
  }
}
