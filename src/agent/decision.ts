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
You are an elite Solana memecoin trader specializing in the "Trenches"
(tokens $20K–$2M market cap).

Your primary lens is Order Flow — buy/sell pressure, smart money activity,
and volume delta. Price action is secondary.

Your goal is to analyze token data and decide: BUY or SKIP.
Protect capital first. A missed trade is always better than a bad entry.

You learn from every decision you make — past learnings are provided in each
request and should influence your judgment.

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
  // Simple rule-based fallback logic
  let action: "BUY" | "SKIP" = "SKIP";
  let reasoning = "Not enough signals";

  if (
    token.smartDegenCount >= 3 &&
    token.rugRatio < 0.2 &&
    token.creatorTokenStatus === "creator_close" &&
    token.liquidity > 50000 &&
    token.top10HolderRate < 0.3 &&
    !token.isWashTrading
  ) {
    action = "BUY";
    reasoning = "Strong signals: smart money, low rug ratio, dev sold, high liquidity";
  }

  return {
    action,
    confidence: 75,
    reasoning,
    signals: ["smart_money", "low_risk"],
  };
}

function buildUserPrompt(
  token: TokenData,
  learnings: Learning[]
): string {
  // Use new pattern scoring system from learner.ts
  const relevantPatterns = getRelevantPatterns(learnings, "BUY");

  const relevantLearnings = relevantPatterns
    .map(p => {
      const scoreIcon = (p.confidence || 0) > 70 ? "🟢" : (p.confidence || 0) > 40 ? "🟡" : "🔴";
      return `${scoreIcon} [${p.type.toUpperCase()}] ${p.description} (${p.successRate}% success, ${p.avgPnlPercent > 0 ? "+" : ""}${p.avgPnlPercent?.toFixed(1)}% avg PnL)`;
    })
    .join("\n");

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
Degens: ${token.smartDegenCount}
${token.topTradersSummary}

━━━ CANDLES 5M (last 12) ━━━
${lastCandles5m}

${token.volumeDeltas5m}

━━━ RISK (FAST FILTER) ━━━
Rug: ${token.rugRatio.toFixed(3)} | Wash: ${token.isWashTrading} | Creator: ${token.creatorTokenStatus}

━━━ TOP ENTRY PATTERNS ━━━
${topEntryPatternsText}

━━━ ALL LEARNINGS ━━━
${relevantLearnings || "None"}
`;
}