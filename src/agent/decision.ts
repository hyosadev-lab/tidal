import type { TokenData, Learning } from "../storage/types";
import { logger } from "../utils/logger";
import { getVolumeDeltasFromKline } from "../utils/kline";

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
You are an expert crypto trader specializing in Solana memecoins "Trenches" — tokens with market cap $20K–$2M.
Your task is to analyze token data and decide whether to BUY or SKIP based on 1-minute entry timing.
Focus on immediate momentum, volume spikes, and recent smart money activity.
Answer ONLY in JSON format: { "action": "BUY"|"SKIP", "confidence": 0-100, "reasoning": "...", "signals": ["signal1", ...] }
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
  const relevantLearnings = learnings
    .filter((l) => l.pattern.type === "entry" || l.pattern.type === "filter")
    .map((l) => l.insight)
    .join("\n");

  // Calculate volume deltas for both timeframes
  // 1m: 5 candles (5 minutes) for recent momentum
  // 5m: 4 candles (20 minutes) for short-term trend
  const volumeDeltas1m = getVolumeDeltasFromKline(token.kline1mData, 5);
  const volumeDeltas5m = getVolumeDeltasFromKline(token.kline5mData, 4);

  // Parse kline data to extract recent price info for 1m entry timing
  const kline1mArray = JSON.parse(token.kline1mData || "[]");
  const recentCandles = kline1mArray.slice(-5); // Last 5 candles for entry timing

  let currentPrice = 0;
  let priceChange5m = 0;
  let recentVolume = 0;

  if (recentCandles.length > 0) {
    const lastCandle = recentCandles[recentCandles.length - 1];
    const firstCandle = recentCandles[0];

    if (lastCandle) currentPrice = lastCandle[4] || 0; // Close price
    if (firstCandle && lastCandle && firstCandle[4]) {
      priceChange5m = ((lastCandle[4] - firstCandle[4]) / firstCandle[4]) * 100;
    }

    // Sum volume from recent candles
    recentVolume = recentCandles.reduce((sum: number, candle: number[]) => sum + (candle[5] || 0), 0);
  }

  return `
TOKEN: ${token.symbol} (${token.address})
Market Cap: $${token.usdMarketCap}
Liquidity: $${token.liquidity}

=== ENTRY TIMING DATA (1-MINUTE FOCUS) ===
Current Price: $${currentPrice.toFixed(6)}
Price Change (5m): ${priceChange5m.toFixed(2)}%
Volume (5m): ${recentVolume.toFixed(2)}
Volume 1h: $${token.volume1h.toFixed(2)} | Swaps 1h: ${token.swaps1h}

K-line 1m (30 candles, focus on last 5 for entry):
${token.kline1mData}

${volumeDeltas1m}

K-line 5m (12 candles for context):
${token.kline5mData}

${volumeDeltas5m}

=== SMART MONEY DATA ===
Smart Degen Count: ${token.smartDegenCount}
Top Smart Degen Traders (holding/activity):
${token.topTradersSummary}

=== RISK METRICS ===
Rug Ratio: ${token.rugRatio} | Bundler Rate: ${token.bundlerTraderAmountRate} | Insider Ratio: ${token.ratTraderAmountRate}
Is Wash Trading: ${token.isWashTrading}
Creator Status: ${token.creatorTokenStatus}
Top 10 Holder Rate: ${token.top10HolderRate}

RELEVANT LEARNINGS from previous trades:
${relevantLearnings || "None"}

=== ENTRY ANALYSIS QUESTIONS ===
1. Is there a volume spike in the last 5 candles (1m)?
2. Is price moving up with increasing volume?
3. Are smart degen traders actively buying right now?
4. Is the current price breaking above recent resistance?
5. Are there any risky signals (high rug ratio, wash trading)?
  `;
}
