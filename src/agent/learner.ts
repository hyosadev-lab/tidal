import type { DecisionRecord, Learning, LearningResponse, PatternAnalysis, LearningScore } from "../storage/types";
import { getDecisions, saveLearnings, getLearnings } from "../storage/db";
import { logger } from "../utils/logger";

let lastLearningsTimestamp = 0;
const LEARNING_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const MIN_DECISIONS_FOR_LEARNING = 5;

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "openrouter/elephant-alpha";
const TEMPERATURE = parseFloat(process.env.TEMPERATURE || "0.3");
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || "5000", 10);

const SYSTEM_PROMPT = `
You are a trading strategy analyst for Solana memecoin "Trenches" trading.

Analyze completed DECISIONS (not trades) and extract actionable patterns to improve future
BUY/SKIP and HOLD/SELL decisions. Focus on:

1. ORDER FLOW — smart money activity, buy/sell pressure, volume delta
2. TIMING — entry/exit timing, dip buying, overextended sells
3. RISK — rug ratio thresholds, wash trading signals, creator behavior
4. VOLUME — volume spike patterns, momentum confirmation

Each decision includes: decision type, confidence, reasoning, signals, and outcome.

Respond ONLY in JSON:
{
  "patterns": [
    {
      "type": "entry" | "exit" | "risk" | "filter" | "timing" | "volume",
      "description": "concise, actionable pattern with specific thresholds",
      "successRate": 0-100,
      "avgPnlPercent": number,
      "appliedCount": number,
      "successCount": number,
      "examples": ["token_address1", "token_address2"]
    }
  ],
  "insights": "1-3 sentences summary of key learnings"
}
`;

/**
 * Generate new learning insights from recent trades
 * Triggered by: time interval (30min) OR minimum decisions threshold
 */
export async function generateLearnings(): Promise<void> {
  try {
    const allDecisions = await getDecisions();

    // Get only completed decisions (success/failure, not pending)
    const completedDecisions = allDecisions.filter(
      (d) => d.outcome === "success" || d.outcome === "failure",
    );

    const successfulDecisions = completedDecisions.filter((d) => d.outcome === "success");
    const failedDecisions = completedDecisions.filter((d) => d.outcome === "failure");

    const now = Date.now();
    const timeSinceLastLearnings = now - lastLearningsTimestamp;

    // Trigger conditions: time-based OR threshold-based
    const shouldGenerateByTime = timeSinceLastLearnings >= LEARNING_INTERVAL_MS;
    const shouldGenerateByThreshold =
      completedDecisions.length >= MIN_DECISIONS_FOR_LEARNING &&
      completedDecisions.length > 0;

    if (!shouldGenerateByTime && !shouldGenerateByThreshold) {
      return;
    }

    // Need enough data to generate meaningful patterns
    if (successfulDecisions.length < 3 && failedDecisions.length < 2) {
      logger.info(`Not enough decisions for learning: ${successfulDecisions.length} success, ${failedDecisions.length} failure`);
      return;
    }

    logger.info(`Generating learnings: ${successfulDecisions.length} success, ${failedDecisions.length} failure decisions`);

    // Get recent decisions for analysis (last 30 for richness)
    const recentDecisions = completedDecisions.slice(-30);
    const recentSuccess = successfulDecisions.slice(-20);
    const recentFailures = failedDecisions.slice(-10);

    // Calculate statistics
    const stats = calculateStatsFromDecisions(recentSuccess, recentFailures);

    // Call OpenRouter for pattern analysis
    const aiResponse = await analyzeWithDecisionsAI(recentDecisions, stats);

    if (aiResponse.patterns.length === 0) {
      logger.warn("No patterns generated from AI analysis");
      return;
    }

    // Save raw AI response with metadata
    const newLearnings: Learning[] = [{
      id: `learning_${Date.now()}`,
      createdAt: now,
      basedOnTradeIds: recentDecisions.slice(-10).map((d) => d.id),
      patterns: aiResponse.patterns,
      insights: aiResponse.insights
    }];

    // Save learnings with cleanup
    const allLearnings = await getLearnings();
    const combinedLearnings = [...allLearnings, ...newLearnings];

    // Cleanup: keep 7 days + consolidate similar patterns
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
    const recentLearnings = combinedLearnings.filter(l => l.createdAt > sevenDaysAgo);

    await saveLearnings(recentLearnings);
    lastLearningsTimestamp = now;

    logger.info(
      `Generated ${aiResponse.patterns.length} new learning patterns from ${recentDecisions.length} decisions`,
    );

    // Log insights for review
    const insightsSummary = aiResponse.patterns
      .map(
        (p) =>
          `[${p.type.toUpperCase()}] ${p.description} (${p.successRate}% success, ${p.avgPnlPercent > 0 ? "+" : ""}${p.avgPnlPercent}% avg PnL)`,
      )
      .join("\n");

    logger.info(`Learning Insights:\n${insightsSummary}`);
    logger.info(`AI Summary: ${aiResponse.insights}`);
  } catch (error) {
    logger.error("Error generating learnings", { error: String(error) });
  }
}

/**
 * Analyze decisions and extract patterns
 */
async function analyzeWithDecisionsAI(
  decisions: DecisionRecord[],
  stats: any,
): Promise<LearningResponse> {
  if (!OPENROUTER_API_KEY) {
    logger.warn("OPENROUTER_API_KEY not set, using fallback pattern analysis");
    return { patterns: fallbackPatternAnalysis(decisions), insights: "Fallback analysis" };
  }

  try {
    const userMessage = buildAnalysisPrompt(decisions, stats);

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
      return { patterns: fallbackPatternAnalysis(decisions), insights: "OpenRouter API error" };
    }

    const data = (await response.json()) as any;
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      logger.error("Invalid OpenRouter response format", { data });
      return { patterns: fallbackPatternAnalysis(decisions), insights: "Invalid response format" };
    }

    const parsed = JSON.parse(content) as LearningResponse;
    return { patterns: parsed.patterns || [], insights: parsed.insights || "No insights" };
  } catch (error) {
    logger.error("Error calling OpenRouter", { error: String(error) });
    return { patterns: fallbackPatternAnalysis(decisions), insights: "Error calling AI" };
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
 * Fallback: Rule-based pattern extraction when AI fails (Decision-based)
 * Extracts patterns directly from decision records without trade conversion
 */
function fallbackPatternAnalysis(decisions: DecisionRecord[]): PatternAnalysis[] {
  const patterns: PatternAnalysis[] = [];

  // Filter decisions by type and outcome
  const buyDecisions = decisions.filter(d => d.decisionType === "BUY");
  const sellDecisions = decisions.filter(d => d.decisionType === "SELL");

  // Get successful and failed BUY decisions
  const successfulBuys = buyDecisions.filter(d => d.outcome === "success");
  const failedBuys = buyDecisions.filter(d => d.outcome === "failure");

  // Pattern 1: Smart money presence at entry
  if (successfulBuys.length >= 2) {
    const smartMoneyBuys = successfulBuys.filter(d => {
      const signals = d.signals || [];
      return signals.includes("smart_money") || signals.includes("smart_degen");
    });
    if (smartMoneyBuys.length > 0) {
      patterns.push({
        type: "entry",
        description: "Smart degen traders present at entry (min 3 degens)",
        successRate: Math.round((smartMoneyBuys.length / successfulBuys.length) * 100),
        avgPnlPercent: calculateAvgPnlFromDecisions(smartMoneyBuys),
        appliedCount: successfulBuys.length,
        successCount: smartMoneyBuys.length,
        examples: smartMoneyBuys.slice(0, 3).map(d => d.tokenAddress),
      });
    }
  }

  // Pattern 2: Dip buying opportunity
  if (buyDecisions.length >= 5) {
    const dipBuys = buyDecisions.filter(d => {
      const signals = d.signals || [];
      return signals.includes("dip_buy") || signals.includes("price_dip");
    });
    const dipWins = dipBuys.filter(d => d.outcome === "success");
    if (dipBuys.length >= 2) {
      patterns.push({
        type: "timing",
        description: "Dip buying: entry during price decline (-10% or more)",
        successRate: Math.round((dipWins.length / dipBuys.length) * 100),
        avgPnlPercent: calculateAvgPnlFromDecisions(dipWins),
        appliedCount: dipBuys.length,
        successCount: dipWins.length,
        examples: dipBuys.slice(0, 3).map(d => d.tokenAddress),
      });
    }
  }

  // Pattern 3: Risk filter - high rug ratio
  const highRiskFailed = failedBuys.filter(d => {
    const signals = d.signals || [];
    return signals.includes("high_risk") || signals.includes("rug_ratio_high");
  });

  if (highRiskFailed.length > 0) {
    patterns.push({
      type: "risk",
      description: "Avoid tokens with rug ratio > 0.3 or wash trading detected",
      successRate: 0,
      avgPnlPercent: calculateAvgPnlFromDecisions(failedBuys),
      appliedCount: highRiskFailed.length,
      successCount: 0,
      examples: highRiskFailed.slice(0, 3).map(d => d.tokenAddress),
    });
  }

  // Pattern 4: Exit timing - quick profit taking (SELL decisions)
  const quickSellWins = sellDecisions.filter(d => {
    if (d.outcome !== "success") return false;
    const holdingMs = d.outcomeDetails?.holdingDurationMs || 0;
    return holdingMs < 10 * 60 * 1000; // Under 10 min
  });

  const allSellWins = sellDecisions.filter(d => d.outcome === "success");
  if (quickSellWins.length > 0 && allSellWins.length > 0) {
    patterns.push({
      type: "timing",
      description: "Quick exit (under 10 min) preserves profit on strong pumps",
      successRate: Math.round((quickSellWins.length / allSellWins.length) * 100) || 100,
      avgPnlPercent: calculateAvgPnlFromDecisions(quickSellWins),
      appliedCount: quickSellWins.length,
      successCount: quickSellWins.length,
      examples: quickSellWins.slice(0, 3).map(d => d.tokenAddress),
    });
  }

  // Pattern 5: Volume spike confirmation
  const volumeBuys = successfulBuys.filter(d => {
    const signals = d.signals || [];
    return signals.includes("volume_spike") || signals.includes("high_volume");
  });
  if (volumeBuys.length >= 2) {
    patterns.push({
      type: "volume",
      description: "Volume spike confirmation for entry signal",
      successRate: Math.round((volumeBuys.length / successfulBuys.length) * 100),
      avgPnlPercent: calculateAvgPnlFromDecisions(volumeBuys),
      appliedCount: successfulBuys.length,
      successCount: volumeBuys.length,
      examples: volumeBuys.slice(0, 3).map(d => d.tokenAddress),
    });
  }

  // Pattern 6: Filter - skip low liquidity
  const lowLiqBuys = buyDecisions.filter(d => {
    const signals = d.signals || [];
    return signals.includes("low_liquidity");
  });
  const lowLiqWins = lowLiqBuys.filter(d => d.outcome === "success");
  if (lowLiqBuys.length >= 2) {
    patterns.push({
      type: "filter",
      description: "Skip tokens with liquidity under $50k",
      successRate: Math.round((lowLiqWins.length / lowLiqBuys.length) * 100),
      avgPnlPercent: calculateAvgPnlFromDecisions(lowLiqBuys.filter(d => d.outcome === "success")),
      appliedCount: lowLiqBuys.length,
      successCount: lowLiqWins.length,
      examples: lowLiqBuys.slice(0, 3).map(d => d.tokenAddress),
    });
  }

  return patterns;
}

/**
 * Score patterns based on recency, success rate, and PnL
 * Higher scores = more weight in decision making
 */
export function scorePattern(
  pattern: PatternAnalysis,
  patternAgeDays: number = 0
): LearningScore {
  // Weights for scoring
  const WEIGHT_SUCCESS = 0.35;
  const WEIGHT_PNL = 0.40;
  const WEIGHT_RECENCY = 0.25;
  const MAX_AGE_DAYS = 7;

  // Recency score: 0-100 (100 = today, 0 = older than max age)
  const recencyScore = Math.max(0, 100 - (patternAgeDays / MAX_AGE_DAYS) * 100);

  // Success rate score (0-100)
  const successScore = pattern.successRate;

  // PnL score: normalize to 0-100 (assuming ±50% PnL range)
  const pnlScore = Math.min(100, Math.max(0, 50 + (pattern.avgPnlPercent || 0)));

  // Weighted composite score
  const compositeScore =
    successScore * WEIGHT_SUCCESS +
    pnlScore * WEIGHT_PNL +
    recencyScore * WEIGHT_RECENCY;

  return {
    patternId: `pattern_${pattern.type}_${pattern.description.substring(0, 20)}`,
    score: compositeScore,
    reason: `Success: ${pattern.successRate}%, PnL: ${pattern.avgPnlPercent?.toFixed(1)}%, Recency: ${recencyScore.toFixed(0)}%`,
  };
}

/**
 * Get relevant learnings for a specific decision context
 * Returns patterns weighted by relevance and recency
 */
export function getRelevantPatterns(
  learnings: Learning[],
  decisionType: "BUY" | "SELL"
): PatternAnalysis[] {
  const now = Date.now();
  const maxAgeDays = 7;

  // Collect all patterns from recent learnings
  const allPatterns = learnings.flatMap((l) => {
    const ageDays = (now - l.createdAt) / (1000 * 60 * 60 * 24);
    if (ageDays > maxAgeDays) return [];

    return l.patterns.map((p) => ({
      pattern: p,
      learningAge: ageDays,
      learningId: l.id,
    }));
  });

  // Filter and score patterns relevant to current decision
  const relevantPatterns = allPatterns
    .filter(({ pattern, learningAge }) => {
      // Age filter: only use patterns from last 7 days
      if (learningAge > maxAgeDays) return false;

      // Type filter: match decision type
      if (decisionType === "BUY") {
        return ["entry", "timing", "volume", "filter"].includes(pattern.type);
      } else {
        return ["exit", "timing", "risk"].includes(pattern.type);
      }
    })
    .map(({ pattern, learningAge }) => {
      const scoreData = scorePattern(pattern, learningAge);
      return {
        ...pattern,
        recencyWeight: 1 - learningAge / maxAgeDays,
        confidence: scoreData.score,
      };
    })
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
    .slice(0, 10); // Return top 10 patterns

  return relevantPatterns;
}

/**
 * Build analysis prompt from decisions (Decision-based)
 */
function buildAnalysisPrompt(decisions: DecisionRecord[], stats: any): string {
  const decisionDetails = decisions
    .map((d) => {
      const status = d.outcome === "success" ? "SUCCESS" :
                     d.outcome === "failure" ? "FAILURE" :
                     d.outcome === "skipped" ? "SKIPPED" : "PENDING";

      const context = d.context || {};
      const outcome = d.outcomeDetails || {};

      return `
[${status}] ${d.tokenSymbol}
Decision: ${d.decisionType} | Confidence: ${d.confidence}%
${context.priceAtTrade ? `Price: $${context.priceAtTrade.toFixed(8)}` : ""}
${context.marketCapAtTrade ? `MC: $${Math.round(context.marketCapAtTrade).toLocaleString()}` : ""}
${outcome.pnlPercent !== undefined ? `PnL: ${outcome.pnlPercent.toFixed(2)}% (${outcome.pnlSol?.toFixed(4)} SOL)` : ""}
${outcome.holdingDurationMs ? `Hold: ${(outcome.holdingDurationMs / 60000).toFixed(1)}m` : ""}
${outcome.exitReason ? `Exit Reason: ${outcome.exitReason}` : ""}
Signals: ${d.signals?.join(", ") || "None"}
Reasoning: ${d.reasoning || "N/A"}
Context: OrderFlow=${context.orderFlowIntensity || "N/A"}, SmartDegen=${context.smartDegenCount || "N/A"}, RugRatio=${context.rugRatio || "N/A"}
`;
    })
    .join("\n---\n");

  const winRate = stats.winRate !== undefined ? stats.winRate : (stats.wins / (stats.wins + stats.losses)) * 100;
  const avgPnl = stats.avgWinPercent !== undefined ? stats.avgWinPercent : 0;
  const avgLoss = stats.avgLossPercent !== undefined ? stats.avgLossPercent : 0;

  return `
Analyze these ${decisions.length} completed decisions and extract Order Flow patterns.
Focus on: smart money activity, buy/sell pressure, volume delta, and entry/exit timing.

Stats:
- Total: ${stats.totalTrades} | Win Rate: ${winRate.toFixed(1)}%
- Avg Win: ${avgPnl.toFixed(2)}% | Avg Loss: ${avgLoss.toFixed(2)}%
- Wins: ${stats.wins} | Losses: ${stats.losses}

Decisions:
${decisionDetails}
`;
}

/**
 * Calculate average PnL from decision records (Decision-based)
 */
function calculateAvgPnlFromDecisions(decisions: DecisionRecord[]): number {
  const sellDecisions = decisions.filter(
    (d) => d.decisionType === "SELL" && d.outcomeDetails?.pnlPercent !== undefined,
  );
  if (sellDecisions.length === 0) return 0;

  const sum = sellDecisions.reduce((acc, d) => acc + (d.outcomeDetails?.pnlPercent || 0), 0);
  return sum / sellDecisions.length;
}

