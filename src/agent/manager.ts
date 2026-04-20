import type { Position, Learning, TokenData } from "../storage/types";
import { logger } from "../utils/logger";

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "openrouter/elephant-alpha";

const SYSTEM_PROMPT = `
You are an expert crypto trader specializing in Solana memecoins "Trenches".
Your task is to evaluate open positions and decide whether to HOLD or SELL.
Answer ONLY in JSON format: { "action": "HOLD"|"SELL", "confidence": 0-100, "reasoning": "...", "signals": ["signal1", ...] }
`;

interface AiManageDecision {
  action: "HOLD" | "SELL";
  confidence: number;
  reasoning: string;
  signals: string[];
}

export function checkHardRules(
  position: Position,
  takeProfitPercent: number,
  stopLossPercent: number
): "take_profit" | "stop_loss" | null {
  if (position.unrealizedPnlPercent !== undefined) {
    if (position.unrealizedPnlPercent >= takeProfitPercent) {
      return "take_profit";
    }
    if (position.unrealizedPnlPercent <= -stopLossPercent) {
      return "stop_loss";
    }
  }
  return null;
}

export async function getManageDecision(
  position: Position,
  tokenData: TokenData, // Current market data
  takeProfitPercent: number,
  stopLossPercent: number,
  learnings: Learning[]
): Promise<AiManageDecision> {
  // 1. Check hard rules
  const hardRule = checkHardRules(position, takeProfitPercent, stopLossPercent);
  if (hardRule) {
    return {
      action: "SELL",
      confidence: 100,
      reasoning: `Hard rule triggered: ${hardRule}`,
      signals: [hardRule],
    };
  }

  // 2. Build user prompt
  const userPrompt = buildUserPrompt(position, tokenData, takeProfitPercent, stopLossPercent, learnings);

  // 3. Call OpenRouter API
  try {
    if (!OPENROUTER_API_KEY) {
      logger.warn("OPENROUTER_API_KEY not set, using fallback rule-based decision");
      return getFallbackDecision(tokenData);
    }

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
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt }
        ],
        response_format: { type: "json_object" },
        temperature: 0.3,
        max_tokens: 1000
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error("OpenRouter API error", { status: response.status, error: errorText });
      return getFallbackDecision(tokenData);
    }

    const data = await response.json() as any;
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      logger.error("Invalid OpenRouter response format", { data });
      return getFallbackDecision(tokenData);
    }

    const decision = JSON.parse(content) as AiManageDecision;
    return decision;

  } catch (error) {
    logger.error("Error calling OpenRouter", { error: String(error) });
    return getFallbackDecision(tokenData);
  }
}

function getFallbackDecision(tokenData: TokenData): AiManageDecision {
  // Simple rule-based fallback logic
  let action: "HOLD" | "SELL" = "HOLD";
  let reasoning = "Defaulting to HOLD";

  // Example logic: Sell if price drops significantly in 1h or smart money exits
  if (tokenData.change1h < -10) {
    action = "SELL";
    reasoning = "Price dropped >10% in 1h";
  }

  return {
    action,
    confidence: 75,
    reasoning,
    signals: ["market_trend"],
  };
}

function buildUserPrompt(
  position: Position,
  tokenData: TokenData,
  takeProfitPercent: number,
  stopLossPercent: number,
  learnings: Learning[]
): string {
  const relevantLearnings = learnings
    .filter((l) => l.pattern.type === "exit" || l.pattern.type === "risk")
    .map((l) => l.insight)
    .join("\n");

  const holdingDurationMs = Date.now() - position.entryTimestamp;
  const holdingDurationHuman = `${Math.floor(holdingDurationMs / (1000 * 60 * 60))}h ${Math.floor((holdingDurationMs % (1000 * 60 * 60)) / (1000 * 60))}m`;

  return `
POSITION: ${position.tokenSymbol} (${position.tokenAddress})
Entry Price: $${position.entryPrice} | Entry Market Cap: $${position.entryMarketCap}
Current Price: $${tokenData.price} | Current Market Cap: $${tokenData.marketCap}
Unrealized PnL: ${position.unrealizedPnlPercent}% ($${position.unrealizedPnlUsd})
Holding Duration: ${holdingDurationHuman}
Cost: $${position.costUsd}

Market Data Latest:
Volume 1h: $${tokenData.volume1h} | Swaps 1h: ${tokenData.swaps1h}
Smart Degen Count: ${tokenData.smartDegenCount} (at entry: N/A) // Simplified for now
Holder Count: ${tokenData.holderCount}
Rug Ratio: ${tokenData.rugRatio}
Creator Status: ${tokenData.creatorTokenStatus}
Is Wash Trading: ${tokenData.isWashTrading}

K-line 1m last (30 candles):
${tokenData.kline1mData}

K-line 5m last (12 candles):
${tokenData.kline5mData}

Take Profit target: +${takeProfitPercent}%
Stop Loss target: -${stopLossPercent}%

RELEVANT LEARNINGS from previous trades:
${relevantLearnings || "None"}
  `;
}
