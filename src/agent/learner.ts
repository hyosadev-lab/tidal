import type { DecisionRecord, Trade, Learning, LearningResponse, PatternAnalysis } from "../storage/types";
import { getDecisions, saveLearnings, getLearnings } from "../storage/db";
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

/**
 * Generate new learning insights from recent trades
 * Called every 5 completed trades
 */
export async function generateLearnings(): Promise<void> {
  try {
    // Use decisions instead of trades for decision-based learning
    const allDecisions = await getDecisions();

    // Get only successful decisions (BUY/SELL with success outcome)
    const successfulDecisions = allDecisions.filter(
      (d) => d.outcome === "success",
    );

    // Get failed decisions for risk patterns
    const failedDecisions = allDecisions.filter(
      (d) => d.outcome === "failure",
    );

    // Generate learnings only when count increases by multiples of 10
    const currentCount = successfulDecisions.length;
    const shouldGenerate =
      currentCount > 0 &&
      currentCount % 10 === 0 &&
      currentCount > lastLearningsCount;

    if (!shouldGenerate) return;

    logger.info(`Generating learnings for ${currentCount} successful decisions`);
    lastLearningsCount = currentCount;

    // Get last 20 successful decisions for analysis
    const recentDecisions = successfulDecisions.slice(-20);
    const recentFailures = failedDecisions.slice(-10);

    // Calculate statistics
    const stats = calculateStatsFromDecisions(recentDecisions, recentFailures);

    // Call OpenRouter for pattern analysis
    const aiResponse = await analyzeWithDecisionsAI(recentDecisions, stats);

    if (aiResponse.patterns.length === 0) {
      logger.warn("No patterns generated from AI analysis");
      return;
    }

    // Save raw AI response with metadata
    const newLearnings: Learning[] = [{
      id: `learning_${Date.now()}`,
      createdAt: Date.now(),
      basedOnTradeIds: recentDecisions.slice(-5).map((d) => d.id),
      patterns: aiResponse.patterns,
      insights: aiResponse.insights
    }];

    // Save learnings (append to existing, keep only recent 7 days)
    const allLearnings = await getLearnings();
    const combinedLearnings = [...allLearnings, ...newLearnings];

    // Cleanup old learnings (older than 7 days)
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recentLearnings = combinedLearnings.filter(l => l.createdAt > sevenDaysAgo);

    await saveLearnings(recentLearnings);


    logger.info(
      `Generated ${aiResponse.patterns.length} new learning patterns from ${recentDecisions.length} decisions (total ${currentCount} successful decisions)`,
    );

    // Log insights for review
    const insightsSummary = aiResponse.patterns
      .map(
        (p) =>
          `[${p.type.toUpperCase()}] ${p.description} (${p.successRate}% success, ${p.avgPnlPercent > 0 ? "+" : ""}${p.avgPnlPercent}% avg PnL)`,
      )
      .join("\n");

    logger.info(`Learning Insights:\n${insightsSummary}`);
    logger.info(`AI Insights Summary: ${aiResponse.insights}`);
  } catch (error) {
    logger.error("Error generating learnings", { error: String(error) });
  }
}

/**
 * Convert decisions to trade-like format for backward compatibility with existing analysis
 */
function decisionsToTrades(decisions: DecisionRecord[]): Trade[] {
  // Filter for BUY and SELL only, as HOLD/SKIP don't have trade execution data
  const tradeDecisions = decisions.filter(d => d.decisionType === "BUY" || d.decisionType === "SELL");

  return tradeDecisions.map((d) => ({
    id: d.id,
    tokenAddress: d.tokenAddress,
    tokenSymbol: d.tokenSymbol,
    tokenName: d.tokenSymbol, // Not available in decision
    action: d.decisionType as "BUY" | "SELL",
    inputAmount: "",
    inputAmountSol: d.outcomeDetails?.pnlSol || 0,
    outputAmount: "",
    priceAtTrade: 0,
    marketCapAtTrade: 0,
    timestamp: d.timestamp,
    orderId: d.outcomeDetails?.orderId || "",
    orderStatus: (d.outcomeDetails?.orderStatus as "pending" | "confirmed" | "failed" | "expired") || "confirmed",
    isDryRun: true,
    entryPrice: 0,
    exitPrice: 0,
    pnlSol: d.outcomeDetails?.pnlSol,
    pnlPercent: d.outcomeDetails?.pnlPercent,
    holdingDurationMs: d.outcomeDetails?.holdingDurationMs,
    exitReason: d.outcomeDetails?.exitReason,
    aiReasoning: d.aiReasoning,
    signalsUsed: d.signals,
  }));
}

/**
 * Analyze decisions and extract patterns
 */
async function analyzeWithDecisionsAI(
  decisions: DecisionRecord[],
  stats: any,
): Promise<LearningResponse> {
  const trades = decisionsToTrades(decisions);

  if (!OPENROUTER_API_KEY) {
    logger.warn("OPENROUTER_API_KEY not set, using fallback pattern analysis");
    return { patterns: fallbackPatternAnalysis(trades), insights: "Fallback analysis" };
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
      return { patterns: fallbackPatternAnalysis(trades), insights: "OpenRouter API error" };
    }

    const data = (await response.json()) as any;
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      logger.error("Invalid OpenRouter response format", { data });
      return { patterns: fallbackPatternAnalysis(trades), insights: "Invalid response format" };
    }

    const parsed = JSON.parse(content) as LearningResponse;
    return { patterns: parsed.patterns || [], insights: parsed.insights || "No insights" };
  } catch (error) {
    logger.error("Error calling OpenRouter", { error: String(error) });
    return { patterns: fallbackPatternAnalysis(trades), insights: "Error calling AI" };
  }
}

/**
 * Calculate statistics from decisions
 */
function calculateStatsFromDecisions(successDecisions: DecisionRecord[], failDecisions: DecisionRecord[]) {
  const totalTrades = successDecisions.length + failDecisions.length;
  const wins = successDecisions.length;
  const losses = failDecisions.length;
  const winRate = totalTrades > 0 ? Math.round((wins / totalTrades) * 100) : 0;
  const avgWinPercent = successDecisions.length > 0
    ? successDecisions.reduce((sum, d) => sum + (d.outcomeDetails?.pnlPercent || 0), 0) / successDecisions.length
    : 0;
  const avgLossPercent = failDecisions.length > 0
    ? failDecisions.reduce((sum, d) => sum + (d.outcomeDetails?.pnlPercent || 0), 0) / failDecisions.length
    : 0;

  return {
    totalTrades,
    wins,
    losses,
    winRate,
    avgWinPercent,
    avgLossPercent,
  };
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
        : t.action === "BUY" ? "BUY" : "SKIP";

      return `
[${status}] ${t.tokenSymbol}
Action: ${t.action} | Status: ${t.orderStatus}
Price: $${t.priceAtTrade?.toFixed(8) || "N/A"} | MC: $${Math.round(t.marketCapAtTrade || 0).toLocaleString()}
${t.action === "SELL" ? `Entry: $${t.entryPrice?.toFixed(8)} | Exit: $${t.exitPrice?.toFixed(8)}
PnL: ${t.pnlPercent?.toFixed(2)}% (${t.pnlSol?.toFixed(4)} SOL)
Hold: ${t.holdingDurationMs ? (t.holdingDurationMs / 60000).toFixed(1) + "m" : "N/A"}
Exit Reason: ${t.exitReason ?? "N/A"}` : ""}
Signals: ${t.signalsUsed?.join(", ") || "None"}
AI Reasoning: ${t.aiReasoning || "N/A"}
`;
    })
    .join("\n---\n");

  // Handle different stats formats
  const winRate = stats.winRate !== undefined ? stats.winRate : (stats.wins / (stats.wins + stats.losses)) * 100;
  const avgPnl = stats.avgPnl !== undefined ? stats.avgPnl : 0;
  const avgHolding = stats.avgHoldingMinutes !== undefined ? stats.avgHoldingMinutes : 0;

  return `
Analyze these ${trades.length} completed decisions and extract Order Flow patterns.
Focus on: smart money activity, buy/sell pressure, volume delta, and entry/exit timing.

Stats:
- Total: ${stats.totalTrades} | Win Rate: ${winRate.toFixed(1)}% | Avg PnL: ${avgPnl.toFixed(4)} SOL | Avg Hold: ${avgHolding.toFixed(1)}m
- Wins: ${stats.wins} | Losses: ${stats.losses}

Decisions:
${tradeDetails}
`;
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

