import type { TokenData, Learning } from "../storage/types";
import { logger } from "../utils/logger";
import { getRelevantPatterns } from "./learner";

interface OpenRouterResponse {
  choices: {
    message: {
      content: string;
    };
  }[];
}

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "openrouter/elephant-alpha";
const TEMPERATURE = parseFloat(process.env.TEMPERATURE || "0.3");
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || "5000", 10);

const SYSTEM_PROMPT = `
You are an elite Solana memecoin trader with **70%+ win rate** and **profit range 10% to infinite**.
You specialize in the "Trenches" (tokens $20K–$2M market cap).

Your track record:
- Win Rate: 70%+
- Profit Range: 10% to infinite (unlimited upside)
- Max acceptable loss: 15% per trade

Your primary lens is Order Flow — buy/sell pressure, smart money activity,
and volume delta. Price action is secondary.

DECISION LOGIC:
- BUY if: strong order flow, smart money accumulation, healthy risk metrics, creator_close (creator sold = no dump risk)
- SKIP if: weak signals, wash trading, creator_hold (creator still holds), or distribution detected
- RUG RATIO: High rug ratio (90%+) is WARNING not auto-skip. Evaluate tradeoff: creator_close = no dump risk, but whale concentration exists. Trenches often have high rug ratio but still pump.
- NET FLOW: For trenches ($20K-$2M MC), focus on direction (positive/negative) not absolute amounts. Low net flow ($50-$500) can be valid.
- Protect capital first. A missed trade is always better than a bad entry.

Your goal is to maintain your 70%+ win rate by selecting high-quality entries only.

You learn from every decision — past learnings are provided and should influence
your judgment.

Respond ONLY in JSON:
{
  "action": "BUY" | "SKIP",
  "confidence": 0-100,
  "reasoning": "2-3 sentences, cite actual numbers",
  "signals": ["signal1", "signal2"],
  "risk_flags": ["flag1"]
}
`;

interface AiDecision {
  action: "BUY" | "SKIP";
  confidence: number;
  reasoning: string;
  signals: string[];
}

export async function getBuySkipDecision(
  token: TokenData,
  learnings: Learning[]
): Promise<AiDecision> {
  // Build user prompt
  const userPrompt = buildUserPrompt(token, learnings);

  // Call OpenRouter API
  try {
    if (!OPENROUTER_API_KEY) {
      logger.warn("OPENROUTER_API_KEY not set, using fallback rule-based decision");
      return getFallbackDecision(token);
    }

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
          { role: "user", content: userPrompt }
        ],
        response_format: { type: "json_object" },
        temperature: TEMPERATURE,
        max_tokens: MAX_TOKENS
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error("OpenRouter API error", { status: response.status, error: errorText });
      return getFallbackDecision(token);
    }

    const data = await response.json() as OpenRouterResponse;
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      logger.error("Invalid OpenRouter response format", { data });
      return getFallbackDecision(token);
    }

    const decision = JSON.parse(content) as AiDecision;
    return decision;
  } catch (error) {
    logger.error("Error calling OpenRouter", { error: String(error) });
    return getFallbackDecision(token);
  }
}

function getFallbackDecision(token: TokenData): AiDecision {
  // Rule-based fallback - permissive for trenches trading
  let action: "BUY" | "SKIP" = "SKIP";
  let reasoning = "Not enough signals";

  // Critical filters only - let high rug ratio pass if creator sold
  // But wash trading is always skip
  if (token.isWashTrading) {
    return { action: "SKIP", confidence: 95, reasoning: "Wash trading detected", signals: ["wash_trading"] };
  }

  if (
    token.smartDegenCount >= 3 &&
    token.creatorTokenStatus === "creator_close" &&
    token.liquidity > 50000 &&
    token.top10HolderRate < 0.5
  ) {
    action = "BUY";
    const rugNote = token.rugRatio > 0.5 ? ` (high rug ${token.rugRatio.toFixed(2)} but creator sold)` : "";
    reasoning = `Smart money detected${rugNote}, liquidity OK`;
  }

  return {
    action,
    confidence: 75,
    reasoning,
    signals: ["smart_money"],
  };
}

function buildUserPrompt(
  token: TokenData,
  learnings: Learning[]
): string {
  // Use new pattern scoring system from learner.ts
  const relevantPatterns = getRelevantPatterns(learnings, ["BUY", "SKIP"])

  // Get top patterns for quick reference
  const topEntryPatterns = relevantPatterns
    .filter(p => p.type === "entry" || p.type === "timing")
    .slice(0, 3);

  const topEntryPatternsText = topEntryPatterns.length > 0
    ? topEntryPatterns.map(p => {
        const scoreIcon = (p.confidence || 0) > 70 ? "🟢" : (p.confidence || 0) > 40 ? "🟡" : "🔴";
        return `${scoreIcon} [${p.type.toUpperCase()}] ${p.description} (${p.successRate}% success, ${p.avgPnlPercent > 0 ? "+" : ""}${p.avgPnlPercent?.toFixed(1)}% avg)`;
      }).join("\n")
    : "None";

  // Get missed opportunity patterns (tokens skipped but went up)
  const missedOpportunityPatterns = relevantPatterns
    .filter(p => p.type === "missed_opportunity")
    .slice(0, 3);

  const missedOpportunityText = missedOpportunityPatterns.length > 0
    ? missedOpportunityPatterns.map(p => {
        const scoreIcon = (p.confidence || 0) > 70 ? "🟢" : (p.confidence || 0) > 40 ? "🟡" : "🔴";
        return `${scoreIcon} [WARNING] ${p.description} (${p.successRate}% success, avg ${p.avgPnlPercent > 0 ? "+" : ""}${p.avgPnlPercent?.toFixed(1)}% gain missed)`;
      }).join("\n")
    : "None";

  // Get filter patterns (quality criteria)
  const filterPatterns = relevantPatterns
    .filter(p => p.type === "filter")
    .slice(0, 3);

  const filterPatternsText = filterPatterns.length > 0
    ? filterPatterns.map(p => {
        const scoreIcon = (p.confidence || 0) > 70 ? "🟢" : (p.confidence || 0) > 40 ? "🟡" : "🔴";
        return `${scoreIcon} [FILTER] ${p.description} (${p.successRate}% success)`;
      }).join("\n")
    : "None";

  const relevantLearnings = relevantPatterns
    .map(p => {
      const scoreIcon = (p.confidence || 0) > 70 ? "🟢" : (p.confidence || 0) > 40 ? "🟡" : "🔴";
      return `${scoreIcon} [${p.type.toUpperCase()}] ${p.description} (${p.successRate}% success, ${p.avgPnlPercent > 0 ? "+" : ""}${p.avgPnlPercent?.toFixed(1)}% avg PnL)`;
    })
    .slice(0, 30)
    .join("\n");

  // Pre-compute flags (adjusted for 5m timeframe)
  const isOverextended = token.priceChange1h > 50;
  const isDip = token.priceChange1h < -20;

  const lastCandles5m = token.kline5mData.trim().split("\n").slice(-12).join("\n");

  return `
TOKEN: ${token.symbol} (${token.address})

━━━ PRICE & VOLUME (1h metrics) ━━━
Price: $${token.price.toFixed(8)}
1h Change: ${token.priceChange1h.toFixed(2)}%${isOverextended ? " ⚠ OVEREXTENDED" : isDip ? " ▼ DIP" : ""}
1h Volume: $${token.volume1h.toFixed(0)}

━━━ ORDER FLOW (CORE SIGNAL) ━━━
Intensity: ${token.orderFlowSummary.intensity.toUpperCase()}
Net Flow: $${token.orderFlowSummary.netFlowUsd.toFixed(2)}
Buy/Sell Ratio: ${token.orderFlowSummary.buySellRatio.toFixed(2)}x
Buy Vol: $${token.orderFlowSummary.buyVolume.toFixed(0)} | Sell Vol: $${token.orderFlowSummary.sellVolume.toFixed(0)}

━━━ SMART MONEY (LEADING INDICATOR) ━━━
Net Flow: $${token.orderFlowSummary.smartMoneyNetFlow.toFixed(2)}
Buys: ${token.orderFlowSummary.smartMoneyBuyCount} | Sells: ${token.orderFlowSummary.smartMoneySellCount}
Active Smart Degens: ${token.activeSmartDegenCount}
${token.topTradersSummary}

━━━ CANDLES 5M (last 12) ━━━
${lastCandles5m}

${token.volumeDeltas5m}

━━━ RISK ━━━
Rug: ${token.rugRatio.toFixed(3)} ${token.rugRatio > 0.7 ? "⚠️ HIGH" : token.rugRatio > 0.3 ? "🟡 MEDIUM" : "🟢 LOW"} ${token.creatorTokenStatus === "creator_close" ? "(creator sold → no dump risk)" : "(creator holds → watch)"} | Wash: ${token.isWashTrading} | Creator: ${token.creatorTokenStatus}

━━━ TOP ENTRY PATTERNS ━━━
${topEntryPatternsText}

━━━ MISSED OPPORTUNITY WARNINGS ━━━
${missedOpportunityText}

━━━ FILTER CRITERIA ━━━
${filterPatternsText}

━━━ RELEVANT LEARNINGS ━━━
${relevantLearnings || "None"}
`;
}