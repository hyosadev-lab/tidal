import type { Position, Learning, TokenData } from "../storage/types";
import { logger } from "../utils/logger";

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "openrouter/elephant-alpha";
const TEMPERATURE = parseFloat(process.env.TEMPERATURE || "0.3");
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || "5000", 10);

const SYSTEM_PROMPT = `
You are an expert crypto trader specializing in Solana memecoins "Trenches".
Your task is to evaluate open positions and decide whether to HOLD or SELL.
CRITICAL INSTRUCTIONS:
1. DO NOT panic sell on minor price fluctuations. Volatility is normal in memecoins.
2. Hard rules (Take Profit and Stop Loss) are enforced separately. Your decision focuses on market analysis.
3. Do not sell immediately after entry (first 1-5 minutes) unless there is clear evidence of a rug pull, massive dump, or broken structure.
4. Ignore short-term noise (1m candles) unless it shows a clear breakdown trend.
5. Focus on broader market structure and smart money activity.
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
): "take_profit" | "stop_loss" | "max_holding_time" | null {
  if (position.unrealizedPnlPercent !== undefined) {
    if (position.unrealizedPnlPercent >= takeProfitPercent) {
      return "take_profit";
    }
    if (position.unrealizedPnlPercent <= -stopLossPercent) {
      return "stop_loss";
    }
  }

  // Time-based stop loss: prevent bagholding
  const MAX_HOLDING_HOURS = parseFloat(process.env.MAX_HOLDING_HOURS || "4");
  const holdingHours = (Date.now() - position.entryTimestamp) / (1000 * 60 * 60);
  if (holdingHours > MAX_HOLDING_HOURS) {
    return "max_holding_time";
  }

  return null;
}

export async function getManageDecision(
  position: Position,
  tokenData: TokenData, // Current market data
  learnings: Learning[]
): Promise<AiManageDecision> {
  // NOTE: Hard rules (TP/SL) are checked in managing.ts BEFORE calling this function
  // This function focuses on AI-driven decisions based on market analysis

  // 1. Build user prompt
  const userPrompt = buildUserPrompt(position, tokenData, learnings);

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
        temperature: TEMPERATURE,
        max_tokens: MAX_TOKENS
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
  // Simple rule-based fallback logic based on available data
  let action: "HOLD" | "SELL" = "HOLD";
  let reasoning = "Defaulting to HOLD";

  // Rule 1: High rug ratio = SELL
  if (tokenData.rugRatio > 0.3) {
    action = "SELL";
    reasoning = `High rug ratio detected: ${tokenData.rugRatio}`;
    return { action, confidence: 85, reasoning, signals: ["rug_ratio"] };
  }

  // Rule 2: Wash trading detected = SELL
  if (tokenData.isWashTrading) {
    action = "SELL";
    reasoning = "Wash trading detected";
    return { action, confidence: 80, reasoning, signals: ["wash_trading"] };
  }

  // Rule 3: Creator still holding (potential sell pressure) = HOLD but cautious
  if (tokenData.creatorTokenStatus === "creator_hold") {
    reasoning = "Creator still holding (watch for sell pressure)";
    return { action, confidence: 60, reasoning, signals: ["creator_hold"] };
  }

  // Rule 4: Low liquidity = SELL
  if (tokenData.liquidity < 10000) {
    action = "SELL";
    reasoning = `Low liquidity: $${tokenData.liquidity}`;
    return { action, confidence: 75, reasoning, signals: ["low_liquidity"] };
  }

  return {
    action,
    confidence: 50,
    reasoning,
    signals: ["default_hold"],
  };
}

function buildUserPrompt(
  position: Position,
  tokenData: TokenData,
  learnings: Learning[]
): string {
  const relevantLearnings = learnings
    .filter((l) => l.pattern.type === "exit" || l.pattern.type === "risk")
    .map((l) => l.insight)
    .join("\n");

  const holdingDurationMs = Date.now() - position.entryTimestamp;
  const holdingDurationHuman = `${Math.floor(holdingDurationMs / (1000 * 60 * 60))}h ${Math.floor((holdingDurationMs % (1000 * 60 * 60)) / (1000 * 60))}m`;

  // Summarize 1m candles to reduce noise
  // const candles1m = tokenData.kline1mData.split("\n").filter(l => l.trim());
  // const last5Candles = candles1m.slice(-5);
  // const summary1m = last5Candles.length > 0
  //   ? last5Candles.join("\n")
  //   : "No recent data";

  return `
POSITION: ${position.tokenSymbol} (${position.tokenAddress})
Entry Price: $${position.entryPrice.toFixed(6)} | Entry Market Cap: $${position.entryMarketCap}
Current Price: $${position.currentPrice?.toFixed(6) || 0} | Current Market Cap: $${position.currentMarketCap}
Unrealized PnL: ${position.unrealizedPnlPercent?.toFixed(2) || 0}% (${(position.unrealizedPnlSol || 0).toFixed(4)} SOL)
Holding Duration: ${holdingDurationHuman}
Cost: ${(position.costSol || 0).toFixed(4)} SOL

=== CURRENT MARKET CONDITIONS ===
Liquidity: $${tokenData.liquidity}
Price Change (5m): ${tokenData.priceChange5m}%
Volume (5m): $${tokenData.volume5m.toFixed(2)}

=== MOMENTUM ANALYSIS ===
K-line 1m (30 candles):
${tokenData.kline1mData}

${tokenData.volumeDeltas1m || "No volume delta data"}

K-line 5m (12 candles):
${tokenData.kline5mData}

${tokenData.volumeDeltas5m || "No volume delta data"}

=== SMART MONEY ACTIVITY ===
Smart Degen Count: ${tokenData.smartDegenCount} (at entry: ${position.smartDegenEntryCount || "N/A"})
Top Smart Degen Traders (current holding/activity):
${tokenData.topTradersSummary || "No trader data"}

=== RISK METRICS ===
Rug Ratio: ${tokenData.rugRatio} | Bundler Rate: ${tokenData.bundlerTraderAmountRate} | Insider Ratio: ${tokenData.ratTraderAmountRate}
Is Wash Trading: ${tokenData.isWashTrading}
Creator Status: ${tokenData.creatorTokenStatus}
Top 10 Holder Rate: ${tokenData.top10HolderRate}

RELEVANT LEARNINGS from previous trades:
${relevantLearnings || "None"}
  `;
}
