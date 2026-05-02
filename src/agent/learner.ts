import type { DecisionRecord, Learning, PatternAnalysis, LearningScore } from "../storage/types";
import { getDecisions, saveLearnings, getLearnings, cleanupOldDecisions } from "../storage/db";
import { logger } from "../utils/logger";

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "openrouter/elephant-alpha";
const TEMPERATURE = parseFloat(process.env.TEMPERATURE || "0.3");
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || "5000", 10);

const SYSTEM_PROMPT = `
You are an expert trading strategy analyst for Solana memecoin "Trenches" trading.

Analyze ALL completed decisions (BUY, SELL, SKIP, HOLD) and extract actionable patterns
to improve future trading decisions.

Focus on:
1. ENTRY TIMING — When to buy, what conditions precede successful buys
2. EXIT TIMING — When to sell, holding duration patterns, take profit signals
3. RISK PATTERNS — When to skip, avoidance criteria, tokens to avoid
4. HOLD PATTERNS — When to hold (profitable), momentum continuation signals
5. HOLD LOSS PATTERNS — When holds result in losses, exit early signals, stop loss triggers
6. SKIP MISSED OPPORTUNITIES — Tokens that were skipped but went up, patterns to watch for
7. ORDER FLOW — Smart money activity, buy/sell pressure patterns
8. VOLUME PATTERNS — Volume spike confirmation, momentum signals

Each decision includes:
- Type: BUY, SELL, SKIP, or HOLD
- Confidence: 0-100
- Signals: List of market signals detected
- Context: Market conditions at decision time
- Outcome: success/failure/skipped/executed
- PnL: For BUY/SELL decisions

Respond ONLY in valid JSON:
{
  "patterns": [
    {
      "type": "entry" | "exit" | "risk" | "filter" | "timing" | "volume" | "hold_loss" | "missed_opportunity",
      "description": "concise, actionable pattern with specific thresholds",
      "successRate": 0-100,
      "avgPnlPercent": number,
      "appliedCount": number,
      "successCount": number,
      "examples": ["token_address1", "token_address2"],
      "conditions": "when this pattern typically occurs"
    }
  ],
  "insights": "1-3 sentences summary of key learnings for future decisions"
}
`;

/**
 * Generate learning insights from ALL decisions using AI
 * Runs every 30 minutes asynchronously
 */
export async function generateLearnings(): Promise<void> {
  if (!OPENROUTER_API_KEY) {
    logger.warn("OPENROUTER_API_KEY not set, skipping learning generation");
    return;
  }

  try {
    const allDecisions = await getDecisions();

    // Get completed decisions (all outcomes except pending)
    const completedDecisions = allDecisions.filter(
      (d) => d.outcome === "success" || d.outcome === "failure" || d.outcome === "skipped" || d.outcome === "executed",
    );

    if (completedDecisions.length < 5) {
      logger.info(`Not enough decisions for learning: ${completedDecisions.length}/5 required`);
      return;
    }

    // Get recent decisions (last 50 or last 7 days)
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recentDecisions = completedDecisions
      .filter(d => d.timestamp > sevenDaysAgo)
      .slice(-50);

    logger.info(`Generating learnings from ${recentDecisions.length} decisions`);

    // Prepare AI prompt with all decision data
    const aiResponse = await analyzeDecisionsWithAI(recentDecisions);

    if (!aiResponse || !aiResponse.patterns || aiResponse.patterns.length === 0) {
      logger.warn("AI returned no patterns");
      return;
    }

    // Valid pattern types only
    const VALID_PATTERN_TYPES = ["entry", "exit", "risk", "filter", "timing", "volume", "hold_loss", "missed_opportunity"];

    // Filter patterns by quality AND valid type
    const MIN_SUCCESS_RATE = 50;
    const MIN_APPLIED_COUNT = 2;
    const filteredPatterns = aiResponse.patterns.filter(p => {
      // Check if type is valid
      if (!VALID_PATTERN_TYPES.includes(p.type)) {
        logger.warn(`Invalid pattern type "${p.type}" skipped: ${p.description}`);
        return false;
      }
      // Check quality thresholds
      return (p.successRate || 0) >= MIN_SUCCESS_RATE &&
             (p.appliedCount || 0) >= MIN_APPLIED_COUNT;
    });

    if (filteredPatterns.length === 0) {
      logger.warn(`No patterns met quality thresholds (min success: ${MIN_SUCCESS_RATE}%, min count: ${MIN_APPLIED_COUNT})`);
      return;
    }

    logger.info(`Generated ${filteredPatterns.length} patterns from ${recentDecisions.length} decisions`);

    // Save learning
    const newLearning: Learning = {
      id: `learning_${Date.now()}`,
      createdAt: Date.now(),
      basedOnTradeIds: recentDecisions.slice(-20).map(d => d.id),
      patterns: filteredPatterns,
      insights: aiResponse.insights
    };

    // Get existing learnings and add new one
    const allLearnings = await getLearnings();
    const combinedLearnings = [...allLearnings, newLearning];

    // Keep only last 7 days of learnings
    const recentLearnings = combinedLearnings.filter(l => l.createdAt > sevenDaysAgo);

    await saveLearnings(recentLearnings);

    // Cleanup old decisions (keep only last 200)
    await cleanupOldDecisions(200);

    // Log insights
    const insightsSummary = filteredPatterns
      .map(p => `[${p.type.toUpperCase()}] ${p.description} (${p.successRate}% success, ${p.avgPnlPercent > 0 ? "+" : ""}${p.avgPnlPercent}% avg PnL)`)
      .join("\n");

    logger.info(`Learning Insights:\n${insightsSummary}`);
    logger.info(`AI Summary: ${aiResponse.insights}`);
  } catch (error) {
    logger.error("Error generating learnings", { error: String(error) });
  }
}

/**
 * Analyze decisions with OpenRouter AI
 */
async function analyzeDecisionsWithAI(decisions: DecisionRecord[]): Promise<{ patterns: PatternAnalysis[]; insights: string }> {
  const userMessage = await buildAnalysisPrompt(decisions);

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        "HTTP-Referer": "https://github.com/hyosadev-lab/tidal",
        "X-Title": "TIDAL · Autonomous Trading Agent"
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMessage }
        ],
        response_format: { type: "json_object" },
        temperature: TEMPERATURE,
        max_tokens: MAX_TOKENS
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error("OpenRouter API error", { status: response.status, error: errorText });
      return { patterns: [], insights: "AI API error" };
    }

    const data = (await response.json()) as any;
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      logger.error("Invalid AI response format", { data: JSON.stringify(data).substring(0, 200) });
      return { patterns: [], insights: "Invalid response format" };
    }

    const parsed = JSON.parse(content);
    return {
      patterns: parsed.patterns || [],
      insights: parsed.insights || "No insights"
    };
  } catch (error) {
    logger.error("Error calling OpenRouter", { error: String(error) });
    return { patterns: [], insights: "AI call failed" };
  }
}

/**
 * Build analysis prompt from decisions
 */
async function buildAnalysisPrompt(decisions: DecisionRecord[]): Promise<string> {
  const decisionDetails = decisions.map(d => {
    const status = d.outcome === "success" ? "SUCCESS" :
                   d.outcome === "failure" ? "FAILURE" :
                   d.outcome === "skipped" ? "SKIPPED" : "EXECUTED";

    const context = d.context || {};
    const outcome = d.outcomeDetails || {};

    return `
[${status}] ${d.tokenSymbol} (${d.decisionType})
Decision: ${d.decisionType} | Confidence: ${d.confidence}%
${context.priceAtTrade ? `Price: $${context.priceAtTrade.toFixed(8)}` : ""}
${context.marketCapAtTrade ? `MC: $${Math.round(context.marketCapAtTrade).toLocaleString()}` : ""}
${outcome.pnlPercent !== undefined ? `PnL: ${outcome.pnlPercent.toFixed(2)}%` : ""}
${outcome.holdingDurationMs ? `Hold: ${(outcome.holdingDurationMs / 60000).toFixed(1)}m` : ""}
Signals: ${d.signals?.join(", ") || "None"}
Reasoning: ${d.reasoning || "N/A"}
Context: OrderFlow=${context.orderFlowIntensity || "N/A"}, SmartDegen=${context.smartDegenCount || "N/A"}, RugRatio=${context.rugRatio || "N/A"}
`;
  }).join("\n---\n");

  const buyDecisions = decisions.filter(d => d.decisionType === "BUY");
  const sellDecisions = decisions.filter(d => d.decisionType === "SELL");
  const skipDecisions = decisions.filter(d => d.decisionType === "SKIP");
  const holdDecisions = decisions.filter(d => d.decisionType === "HOLD");

  const successfulBuys = buyDecisions.filter(d => d.outcome === "success");
  const successfulSells = sellDecisions.filter(d => d.outcome === "success");
  const successfulSkips = skipDecisions.filter(d => d.outcome === "skipped");
  const successfulHolds = holdDecisions.filter(d => d.outcome === "executed");

  // Analyze HOLD decisions with outcomes
  const holdsWithOutcome = holdDecisions.filter(d => d.outcomeDetails?.holdOutcome);
  const profitableHolds = holdsWithOutcome.filter(d => d.outcomeDetails?.holdOutcome === "profit");
  const losingHolds = holdsWithOutcome.filter(d => d.outcomeDetails?.holdOutcome === "loss");
  const breakevenHolds = holdsWithOutcome.filter(d => d.outcomeDetails?.holdOutcome === "breakeven");

  // Get missed opportunity stats
  const skippedStats = await analyzeSkippedTokens();

  // Format missed opportunity details for the prompt
  const missedOpportunityText = skippedStats.missedOpportunityDetails.length > 0
    ? skippedStats.missedOpportunityDetails.slice(0, 5).map(d =>
        `  - ${d.tokenSymbol}: MC ${d.marketCapAtSkip.toFixed(0)} → ${d.currentMarketCap.toFixed(0)} (${d.changePercent > 0 ? '+' : ''}${d.changePercent.toFixed(1)}%)`
      ).join("\n")
    : "  (No missed opportunities detected)";

  return `
Analyze these ${decisions.length} completed decisions to extract patterns.

DECISION SUMMARY:
- BUY: ${buyDecisions.length} (${successfulBuys.length} success)
- SELL: ${sellDecisions.length} (${successfulSells.length} success)
- SKIP: ${skipDecisions.length} (${successfulSkips.length} skipped)
- HOLD: ${holdDecisions.length} (${successfulHolds.length} held)

HOLD OUTCOME ANALYSIS:
- Holds with outcome: ${holdsWithOutcome.length}
- Profitable holds: ${profitableHolds.length}
- Losing holds: ${losingHolds.length}
- Breakeven holds: ${breakevenHolds.length}

MISSED OPPORTUNITY ANALYSIS (Last 24h):
- Total skipped: ${skippedStats.totalSkipped}
- Missed opportunities (>50% gain between skips): ${skippedStats.missedOpportunities}
- Good skips (<20% change between skips): ${skippedStats.goodSkips}
- Uncertain range: ${skippedStats.uncertain}
- Missed opportunity rate: ${skippedStats.missedOpportunityRate.toFixed(1)}%

Missed Opportunity Examples:
${missedOpportunityText}

Decisions:
${decisionDetails}

Generate patterns for:
1. ENTRY: When to BUY (conditions, signals, timing)
2. EXIT: When to SELL (take profit, stop loss signals)
3. RISK: When to SKIP (avoidance criteria)
4. HOLD: When to HOLD (momentum continuation)
5. MISSED OPPORTUNITIES: When SKIP decisions resulted in missed gains (adjust skip criteria)
`;
}

/**
 * Get relevant patterns for a specific decision type
 */
export function getRelevantPatterns(
  learnings: Learning[],
  decisionType: ("BUY" | "SELL" | "SKIP" | "HOLD")[]
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

  // Filter patterns by decision type relevance
  const relevantPatterns = allPatterns
    .filter(({ pattern, learningAge }) => {
      // Age filter
      if (learningAge > maxAgeDays) return false;

      // Quality filter
      if ((pattern.successRate || 0) < 50) return false;
      if ((pattern.appliedCount || 0) < 2) return false;

      const patternType: string[] = []

      if (decisionType.includes("BUY")) {
        patternType.push("entry", "timing", "volume")
      }
      if (decisionType.includes("SKIP")) {
        patternType.push("risk", "filter", "missed_opportunity")
      }
      if (decisionType.includes("SELL")) {
        patternType.push("exit", "timing")
      }
      if (decisionType.includes("HOLD")) {
        patternType.push("timing", "hold_loss")
      }

      return patternType.includes(pattern.type)
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

  return relevantPatterns;
}

/**
 * Score patterns based on success rate, PnL, and recency
 */
export function scorePattern(
  pattern: PatternAnalysis,
  patternAgeDays: number = 0
): LearningScore {
  const WEIGHT_SUCCESS = 0.35;
  const WEIGHT_PNL = 0.40;
  const WEIGHT_RECENCY = 0.25;
  const MAX_AGE_DAYS = 7;

  // Recency: 100 = today, 0 = 7+ days ago
  const recencyScore = Math.max(0, 100 - (patternAgeDays / MAX_AGE_DAYS) * 100);

  // Success rate: 0-100
  const successScore = pattern.successRate || 0;

  // PnL: For SKIP/HOLD, use success rate as proxy
  let pnlScore: number;
  if (pattern.avgPnlPercent === 0 && ["risk", "filter", "missed_opportunity", "timing", "hold_loss"].includes(pattern.type)) {
    pnlScore = successScore; // Use success rate for non-PnL patterns
  } else {
    pnlScore = Math.min(100, Math.max(0, pattern.avgPnlPercent || 0));
  }

  // Weighted composite score
  const compositeScore =
    successScore * WEIGHT_SUCCESS +
    pnlScore * WEIGHT_PNL +
    recencyScore * WEIGHT_RECENCY;

  return {
    patternId: `pattern_${pattern.type}_${pattern.description.substring(0, 20)}`,
    score: compositeScore,
    reason: `Success: ${successScore}%, PnL: ${pattern.avgPnlPercent?.toFixed(1)}%, Recency: ${recencyScore.toFixed(0)}%`,
  };
}

/**
 * Analyze skipped tokens for missed opportunities
 * Uses multiple skips of same token to detect market movements without API calls
 */
export async function analyzeSkippedTokens(): Promise<{
  totalSkipped: number;
  missedOpportunities: number;
  goodSkips: number;
  uncertain: number;
  missedOpportunityRate: number;
  missedOpportunityDetails: {
    tokenSymbol: string;
    tokenAddress: string;
    marketCapAtSkip: number;
    currentMarketCap: number;
    changePercent: number;
  }[];
}> {
  try {
    const allDecisions = await getDecisions();

    // Get SKIP decisions from the last 24 hours
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const skippedDecisions = allDecisions.filter(d =>
      d.decisionType === "SKIP" &&
      d.outcome === "skipped" &&
      d.timestamp > oneDayAgo &&
      d.context?.marketCapAtTrade !== undefined
    );

    if (skippedDecisions.length === 0) {
      return {
        totalSkipped: 0,
        missedOpportunities: 0,
        goodSkips: 0,
        uncertain: 0,
        missedOpportunityRate: 0,
        missedOpportunityDetails: []
      };
    }

    logger.info(`Analyzing ${skippedDecisions.length} skipped tokens for missed opportunities`);

    // Group skipped decisions by token address
    const skippedByToken: Record<string, DecisionRecord[]> = {};
    for (const decision of skippedDecisions) {
      if (!skippedByToken[decision.tokenAddress]) {
        skippedByToken[decision.tokenAddress] = [];
      }
      skippedByToken[decision.tokenAddress].push(decision);
    }

    const missedOpportunityDetails: {
      tokenSymbol: string;
      tokenAddress: string;
      marketCapAtSkip: number;
      currentMarketCap: number;
      changePercent: number;
    }[] = [];

    let missedOpportunities = 0;
    let goodSkips = 0;
    let uncertain = 0;
    let totalComparisons = 0;

    // Analyze each token that was skipped multiple times
    for (const [tokenAddress, decisions] of Object.entries(skippedByToken)) {
      if (decisions.length < 2) continue; // Skip tokens with only 1 skip

      // Sort by timestamp (oldest first)
      decisions.sort((a, b) => a.timestamp - b.timestamp);

      const tokenSymbol = decisions[0].tokenSymbol;

      // Compare consecutive skips
      for (let i = 1; i < decisions.length; i++) {
        const prevDecision = decisions[i - 1];
        const currDecision = decisions[i];

        const prevMC = prevDecision.context?.marketCapAtTrade || 0;
        const currMC = currDecision.context?.marketCapAtTrade || 0;

        if (prevMC === 0) continue;

        const changePercent = ((currMC - prevMC) / prevMC) * 100;
        totalComparisons++;

        // Categorize based on price movement between skips
        if (changePercent > 25) {
          // Token went up significantly between skips - potential missed opportunity
          missedOpportunities++;
          missedOpportunityDetails.push({
            tokenSymbol,
            tokenAddress,
            marketCapAtSkip: prevMC,
            currentMarketCap: currMC,
            changePercent: Math.round(changePercent * 100) / 100,
          });
        } else if (changePercent < -20) {
          // Token went down significantly between skips - good skip decision
          goodSkips++;
        } else {
          // Uncertain range - not enough movement to judge
          uncertain++;
        }
      }
    }

    logger.info(
      `Missed opportunity analysis: ${missedOpportunities} missed, ${goodSkips} good, ${uncertain} uncertain (${totalComparisons} comparisons)`,
    );

    return {
      totalSkipped: skippedDecisions.length,
      missedOpportunities,
      goodSkips,
      uncertain,
      missedOpportunityRate: totalComparisons > 0 ? (missedOpportunities / totalComparisons) * 100 : 0,
      missedOpportunityDetails,
    };
  } catch (error) {
    logger.error("Error analyzing skipped tokens", { error: String(error) });
    return {
      totalSkipped: 0,
      missedOpportunities: 0,
      goodSkips: 0,
      uncertain: 0,
      missedOpportunityRate: 0,
      missedOpportunityDetails: [],
    };
  }
}
