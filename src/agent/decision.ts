import type { TokenData, Learning } from "../storage/types";
import { logger } from "../utils/logger";

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
You are an expert ORDER FLOW TRADER specializing in Solana memecoins "Trenches" — tokens with market cap $20K–$2M.
Your task is to analyze token data and decide whether to BUY or SKIP based on 1-minute entry timing.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ORDER FLOW & MOMENTUM ANALYSIS FRAMEWORK
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Your primary focus is ORDER FLOW data (buy/sell pressure from traders):
1. **Net Flow**: Positive = buying pressure, Negative = selling pressure
2. **Buy/Sell Ratio**: > 1.0 = more buyers than sellers
3. **Smart Money Flow**: Net flow from smart degen traders (most reliable signal)
4. **Intensity**: Bullish = accumulation, Bearish = distribution, Neutral = undecided

**Momentum Analysis (Predictive Intuition):**
- Look for "Pump Intention": Volume spikes + Price uptick in 1m candles = Strong momentum
- **Volume Delta**: Increasing volume on green candles = Real buying interest
- **Trend Confirmation**: Look for higher lows or breakout above recent resistance
- **Avoid Local Tops**: Don't buy if price already pumped >20% in 5m (overextended)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BUY DECISION CRITERIA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BUY if ALL of these are true:
- Order Flow Intensity is BULLISH or NEUTRAL-BULLISH
- Net Flow (USD) > $500 (buying pressure from ALL traders)
- Buy/Sell Ratio > 1.0 (more buyers than sellers)
- Price is NOT dropping (priceChange5m >= -5%)
- **Price Change 5m < 20%** (avoid buying local tops)

Smart Money Check (ONE of these must be true):
- Smart Money Net Flow > $0 (smart money actively buying) OR
- Smart Money Buys > Smart Money Sells (more smart money buying than selling) OR
- Smart Degen Count >= 2 AND Smart Money Sells = 0 (smart degens present, none selling)

**Momentum Check (ONE of these must be true):**
- Volume spike in last 3 candles aligned with price increase OR
- Price breaking above recent resistance (1m candles) OR
- Increasing volume on green candles (accumulation pattern)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SKIP CRITERIA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SKIP if ANY of these are true:
- Order Flow Intensity is BEARISH (smart money distributing)
- Net Flow (USD) < -$500 (strong selling pressure from all traders)
- Smart Money Net Flow < -$500 (smart money actively selling/distributing)
- Smart Money Sells > Smart Money Buys AND Smart Money Net Flow < $0
- High risk metrics (rug_ratio > 0.3, wash_trading true)
- **Price Change 5m > 20%** (overextended, likely local top)

NOTE: Do NOT skip just because smart money is neutral or absent. Retail buying pressure (Net Flow > $500, Buy/Sell Ratio > 1.0) can be valid if no smart money selling pressure.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
VOLUME SPIKE CONFIRMATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Look for volume spikes in 1m candles aligned with order flow buying
- If volume spike BUT order flow is bearish → SKIP (trap/bull trap)
- If volume spike AND order flow bullish → BUY (real momentum)
- **Volume Delta Analysis**: Increasing volume on green candles = accumulation, Decreasing volume on green candles = weakness

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
  learnings: Learning[],
  takeProfitPercent: number,
  stopLossPercent: number
): Promise<AiDecision> {
  // Build user prompt
  const userPrompt = buildUserPrompt(token, learnings, takeProfitPercent, stopLossPercent);

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
  learnings: Learning[],
  takeProfitPercent: number,
  stopLossPercent: number
): string {
  // Filter learnings: only show recent, relevant ones (max 3)
  const relevantLearnings = learnings
    .filter((l) => {
      // Only consider entry and filter patterns
      if (l.pattern.type !== "entry" && l.pattern.type !== "filter") return false;

      // Only consider learnings from last 7 days
      const ageDays = (Date.now() - l.createdAt) / (1000 * 60 * 60 * 24);
      if (ageDays > 7) return false;

      return true;
    })
    .sort((a, b) => b.createdAt - a.createdAt) // Most recent first
    .slice(0, 3) // Limit to 3 learnings
    .map((l) => l.insight)
    .join("\n");

  return `
TOKEN: ${token.symbol} (${token.address})
Market Cap: $${token.usdMarketCap}
Liquidity: $${token.liquidity}

=== ENTRY TIMING DATA (1-MINUTE FOCUS) ===
Current Price: $${token.price.toFixed(6)}
Price Change (5m): ${token.priceChange5m.toFixed(2)}%
Volume (5m): ${token.volume5m.toFixed(2)}

K-line 1m (30 candles):
${token.kline1mData}

${token.volumeDeltas1m}

K-line 5m (12 candles):
${token.kline5mData}

${token.volumeDeltas5m}

=== ORDER FLOW DATA ===
Current Intensity: ${token.orderFlowSummary.intensity.toUpperCase()}
Net Flow (USD): $${token.orderFlowSummary.netFlowUsd.toFixed(2)}
Buy/Sell Ratio: ${token.orderFlowSummary.buySellRatio.toFixed(2)}
Total Buy Volume: $${token.orderFlowSummary.buyVolume.toFixed(2)}
Total Sell Volume: $${token.orderFlowSummary.sellVolume.toFixed(2)}

Smart Money Flow: $${token.orderFlowSummary.smartMoneyNetFlow.toFixed(2)}
Smart Money Buys: ${token.orderFlowSummary.smartMoneyBuyCount}
Smart Money Sells: ${token.orderFlowSummary.smartMoneySellCount}

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
6. **Is price overextended (>20% in 5m) or just starting momentum?**

=== MOMENTUM ANALYSIS (PREDICTIVE) ===
1. **Volume Delta**: Is volume increasing on green candles? (Accumulation)
2. **Trend Pattern**: Are we seeing higher lows? (Uptrend forming)
3. **Breakout**: Is price breaking above recent resistance levels?
4. **Momentum Intensity**: Are green candles getting bigger? (Strengthening trend)
5. **Prediction**: Based on current order flow and volume, is the next 5m likely UP or DOWN?

=== ORDER FLOW ENTRY ANALYSIS ===
1. Is Order Flow Intensity BULLISH? (Net Flow > 0, Buy/Sell Ratio > 1.0)
2. Is Smart Money Net Flow POSITIVE? (Smart degen accumulation)
3. Are Smart Money Buys > Smart Money Sells? (Whales buying)
4. Does volume spike align with positive order flow? (Real momentum vs trap)
5. Is there any bearish order flow warning? (Selling pressure building)

Key Decision Logic:
- BUY if: Bullish order flow + volume spike + smart money buying + momentum confirmation + predicted UP
- SKIP if: Bearish order flow OR smart money selling OR high risk metrics OR overextended price OR predicted DOWN

=== TRADING TARGETS ===
Take Profit Target: +${takeProfitPercent}%
Stop Loss Target: -${stopLossPercent}%

=== ENTRY THRESHOLDS ===
Price Change 5m Max: +20% (avoid buying local tops)
Net Flow Min: $500 (buying pressure threshold)
  `;
}
