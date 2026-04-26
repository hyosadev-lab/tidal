import type { Position, Learning, TokenData } from "../storage/types";
import { logger } from "../utils/logger";

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "openrouter/elephant-alpha";
const TEMPERATURE = parseFloat(process.env.TEMPERATURE || "0.3");
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || "5000", 10);

const SYSTEM_PROMPT = `
You are an expert crypto trader specializing in Solana memecoins "Trenches".
Your task is to evaluate open positions and decide whether to HOLD or SELL.
You are trading in a 1-MINUTE timeframe on highly volatile tokens.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CORE MINDSET
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- These tokens can pump 100%+ and dump 80%+ within minutes.
- Your #1 job is to PROTECT PROFITS and CUT LOSSES — not to hope.
- "Waiting for more confirmation" is how you turn a winner into a loser.
- Hard rules (Take Profit / Stop Loss) are enforced by the system separately. Do NOT factor them into your decision.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PROFIT PROTECTION RULE (ALL PHASES)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
If unrealizedPnlPercent >= 40%:
- The priority shifts from "let it run" to "lock in gains".
- ANY single sell signal below is sufficient to SELL. No multiple confirmations needed.
- Do NOT hold waiting for higher prices. A 40%+ gain is a success — secure it.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PHASE 1 — Early Hold (0–5 minutes after entry)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Default: HOLD. The token needs time to develop momentum.
Only SELL if ANY of these hard signals appear:
- A single 1m candle drops >20%
- rug_ratio > 0.5
- is_wash_trading becomes true

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PHASE 2 — Active Evaluation (5–15 minutes after entry)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Score the following sell signals. Each TRUE = 1 point:
[ ] 3+ consecutive 1m candles making lower highs AND volume declining
[ ] smartDegenCount dropped vs entry count
[ ] A single 1m candle dropped >10% with high volume (distribution)
[ ] creatorTokenStatus changed to creator_close after entry (dev dumped into pump)
[ ] 5m price change is negative AND volume on last 5m candle is declining

Score >= 2 → SELL. No exceptions. Do not add other reasoning to override this score.
Score = 1 → HOLD but increase caution.
Score = 0 → HOLD.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PHASE 3 — Late Hold (>15 minutes after entry)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Score the following sell signals. Each TRUE = 1 point:
[ ] Volume declining for 3+ consecutive 1m candles
[ ] Price failed to make new highs in last 5 minutes
[ ] smartDegenCount declining vs entry
[ ] Any risk metric worsening (rug_ratio rising, wash_trading detected)

Score >= 2 → SELL. No exceptions. Do not add other reasoning to override this score.
Score >= 1 AND unrealizedPnlPercent > 0 → SELL. Lock in any profit.
Score = 0 → HOLD.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ANTI-OVERRIDE RULE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
When a score threshold is met, you MUST output SELL.
You are NOT allowed to:
- Add conditions not listed above to justify HOLD
- Use "rug_ratio is 0" or "no wash trading" to override a SELL score
- Wait for "more confirmation" when score threshold is already reached
- Output confidence < 70 when score threshold is met (uncertainty is not an excuse to hold)

Answer ONLY in JSON format: { "action": "HOLD"|"SELL", "confidence": 0-100, "reasoning": "...", "signals": ["signal1", ...] }
In your reasoning, always state: current phase, score, and which signals triggered.
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
): "take_profit" | "stop_loss" | "invalid_price" | null {
  // 1. Check for Invalid/Zero Prices (Critical Risk)
  if (!position.currentPrice || position.currentPrice <= 0) {
    logger.warn(`Invalid current price for ${position.tokenSymbol}: ${position.currentPrice}. Triggering sell.`);
    return "invalid_price";
  }

  // 2. Check Take Profit / Stop Loss
  if (position.unrealizedPnlPercent !== undefined && !isNaN(position.unrealizedPnlPercent)) {
    if (position.unrealizedPnlPercent >= takeProfitPercent) {
      return "take_profit";
    }
    if (position.unrealizedPnlPercent <= -stopLossPercent) {
      return "stop_loss";
    }
  } else {
    // If PnL is undefined/NaN, we can't calculate TP/SL safely.
    // Treat as high risk to prevent holding invalid data.
    logger.warn(`Invalid PnL for ${position.tokenSymbol}. Triggering sell.`);
    return "invalid_price";
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
  // Filter learnings: only show recent, relevant ones (max 3)
  const relevantLearnings = learnings
    .filter((l) => {
      // Only consider exit and risk patterns
      if (l.pattern.type !== "exit" && l.pattern.type !== "risk") return false;

      // Only consider learnings from last 7 days
      const ageDays = (Date.now() - l.createdAt) / (1000 * 60 * 60 * 24);
      if (ageDays > 7) return false;

      return true;
    })
    .sort((a, b) => b.createdAt - a.createdAt) // Most recent first
    .slice(0, 3) // Limit to 3 learnings
    .map((l) => l.insight)
    .join("\n");

  const holdingDurationMs = Date.now() - position.entryTimestamp;
  const holdingDurationHuman = `${Math.floor(holdingDurationMs / (1000 * 60 * 60))}h ${Math.floor((holdingDurationMs % (1000 * 60 * 60)) / (1000 * 60))}m`;

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
