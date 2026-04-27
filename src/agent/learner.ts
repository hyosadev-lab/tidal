import type { Trade, Learning } from "../storage/types";
import { getTrades, saveLearnings, getLearnings } from "../storage/db";
import { logger } from "../utils/logger";

let lastLearningsCount = 0;

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "openrouter/elephant-alpha";
const TEMPERATURE = parseFloat(process.env.TEMPERATURE || "0.3");
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || "5000", 10);

const SYSTEM_PROMPT = `
You are an expert TRADING STRATEGY ANALYST specializing in Solana memecoins "Trenches".

Your task: Analyze completed trades and extract actionable patterns to improve future decisions.

Analyze these trades:
- Which ENTRY signals led to WINS vs LOSSES?
- Which EXIT signals preserved profits vs caused losses?
- What RISK indicators correlated with failures?
- What FILTER rules should be applied to skip bad tokens?

Format your analysis into specific, actionable patterns.

Pattern types to extract:
1. entry: Signals for successful entries
2. exit: Signals for optimal exits
3. risk: Red flags to avoid
4. filter: Criteria to skip tokens

For each pattern, provide:
- description: What to look for
- successRate: % of trades that worked
- avgPnlPercent: Average return when this pattern appears
- appliedCount: How often this pattern was observed
- successCount: How often it led to wins

Answer in JSON format:
{
  "patterns": [
    {
      "type": "entry"|"exit"|"risk"|"filter",
      "description": "...",
      "successRate": 0-100,
      "avgPnlPercent": number,
      "appliedCount": number,
      "successCount": number
    }
  ],
  "insights": "Brief summary of key findings"
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

    // Generate learnings only when count increases by multiples of 5
    // e.g., if last count was 0 and now 5, generate. If 5 and still 5, don't generate.
    const currentCount = confirmedTrades.length;
    const shouldGenerate =
      currentCount > 0 &&
      currentCount % 5 === 0 &&
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

    logger.info(
      `Generated ${newLearnings.length} new learning patterns from ${recentTrades.length} trades`,
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
      const isWin = t.pnlSol && t.pnlSol > 0;
      const status = t.action === "SELL" ? (isWin ? "WIN" : "LOSS") : "BUY";

      return `
Trade #${t.id} - ${status}
Action: ${t.action}
Token: ${t.tokenSymbol} (${t.tokenAddress})
Entry Price: $${t.priceAtTrade.toFixed(6)}
${t.action === "SELL" ? `Exit Price: $${t.exitPrice?.toFixed(6) || "N/A"}` : ""}
${t.pnlSol !== undefined ? `PnL: ${t.pnlSol.toFixed(4)} SOL (${t.pnlPercent?.toFixed(2)}%)` : ""}
${t.holdingDurationMs ? `Holding: ${(t.holdingDurationMs / 60000).toFixed(1)} min` : ""}
Signals Used: ${t.signalsUsed?.join(", ") || "None"}
Reasoning: ${t.aiReasoning || "N/A"}
Exit Reason: ${t.exitReason || "N/A"}
    `;
    })
    .join("\n---\n");

  return `
TRADE ANALYSIS REQUEST

Overall Stats:
- Total Trades: ${stats.totalTrades}
- Win Rate: ${stats.winRate.toFixed(1)}%
- Avg PnL: ${stats.avgPnl.toFixed(4)} SOL
- Avg Holding Time: ${stats.avgHoldingMinutes.toFixed(1)} min

TRADE DETAILS:

${tradeDetails}

ANALYSIS QUESTIONS:
1. What ENTRY signals appear most in winning trades?
2. What ENTRY signals appear most in losing trades?
3. What EXIT strategies work best?
4. What RISK signals correlate with losses?
5. What FILTER rules should prevent bad buys?

Return patterns with specific, actionable criteria.
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

/**
 * Get relevant learnings for current decision context
 * Filters learnings by type and returns formatted string for AI prompts
 */
export async function getRelevantLearnings(
  contextType: "entry" | "exit" | "risk" | "filter",
): Promise<string> {
  try {
    const learnings = await getLearnings();

    if (learnings.length === 0) {
      return "No historical learnings available yet.";
    }

    // Filter by context type
    const relevant = learnings.filter((l) => l.pattern.type === contextType);

    if (relevant.length === 0) {
      return `No ${contextType} pattern learnings available yet.`;
    }

    // Sort by success rate (descending) and take top 5
    const sorted = relevant
      .sort(
        (a, b) => (b.pattern.successRate || 0) - (a.pattern.successRate || 0),
      )
      .slice(0, 5);

    // Format for AI prompt
    const formatted = sorted
      .map((l) => {
        const stats = `(${l.pattern.successRate}% success, avg ${l.pattern.avgPnlPercent > 0 ? "+" : ""}${l.pattern.avgPnlPercent}%)`;
        return `- ${l.pattern.description} ${stats} [applied ${l.pattern.appliedCount} times]`;
      })
      .join("\n");

    return `RELEVANT ${contextType.toUpperCase()} LEARNINGS:\n${formatted}`;
  } catch (error) {
    logger.error("Error getting relevant learnings", { error: String(error) });
    return "Error loading learnings.";
  }
}

/**
 * Get all learnings as summary string
 */
export async function getLearningsSummary(): Promise<string> {
  try {
    const learnings = await getLearnings();

    if (learnings.length === 0) {
      return "No learnings available yet. Need 5+ trades to generate patterns.";
    }

    const byType = {
      entry: learnings.filter((l) => l.pattern.type === "entry"),
      exit: learnings.filter((l) => l.pattern.type === "exit"),
      risk: learnings.filter((l) => l.pattern.type === "risk"),
      filter: learnings.filter((l) => l.pattern.type === "filter"),
    };

    const summary = Object.entries(byType)
      .filter(([_, items]) => items.length > 0)
      .map(([type, items]) => {
        const avgSuccess =
          items.reduce((sum, l) => sum + l.pattern.successRate, 0) /
          items.length;
        const avgPnl =
          items.reduce((sum, l) => sum + l.pattern.avgPnlPercent, 0) /
          items.length;
        return `${type.toUpperCase()}: ${items.length} patterns, avg ${avgSuccess.toFixed(0)}% success, avg ${avgPnl > 0 ? "+" : ""}${avgPnl.toFixed(1)}% PnL`;
      })
      .join("\n");

    return `LEARNING SUMMARY (${learnings.length} total patterns):\n${summary}`;
  } catch (error) {
    logger.error("Error getting learnings summary", { error: String(error) });
    return "Error loading learnings summary.";
  }
}
