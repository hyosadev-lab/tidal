import type { TokenData, Learning } from "../storage/types";
import { logger } from "../utils/logger";

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "openrouter/elephant-alpha";

const SYSTEM_PROMPT = `
You are an expert crypto trader specializing in Solana memecoins "Trenches" — tokens with market cap $20K–$2M.
Your task is to analyze token data and decide whether to BUY or SKIP.
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
  // 1. Hard rules check (Quality Gate)
  // Quick disqualification: rug_ratio > 0.3 OR is_wash_trading = true
  if (token.rugRatio > 0.3) {
    return {
      action: "SKIP",
      confidence: 100,
      reasoning: `High rug ratio: ${token.rugRatio}`,
      signals: ["high_rug_ratio"],
    };
  }
  if (token.isWashTrading) {
    return {
      action: "SKIP",
      confidence: 100,
      reasoning: "Wash trading detected",
      signals: ["wash_trading"],
    };
  }
  if (token.smartDegenCount === 0) {
    return {
      action: "SKIP",
      confidence: 80,
      reasoning: "No smart money holders",
      signals: ["zero_smart_degen"],
    };
  }

  // 2. Build user prompt
  const userPrompt = buildUserPrompt(token, learnings);

  // 3. Call OpenRouter API
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
        temperature: 0.3,
        max_tokens: 1000
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error("OpenRouter API error", { status: response.status, error: errorText });
      return getFallbackDecision(token);
    }

    const data = await response.json() as any;
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
    token.liquidity > 50000
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

  return `
TOKEN: ${token.symbol} (${token.address})
Market Cap: $${token.usdMarketCap}
Liquidity: $${token.liquidity}
Volume 24h: $${token.volume24h}
Swaps 24h: ${token.swaps24h}
Buys 24h: ${token.buys24h} | Sells 24h: ${token.sells24h}
Holder Count: ${token.holderCount}
Smart Degen Count: ${token.smartDegenCount}
Renowned Count: ${token.renownedCount}
Top 10 Holder Rate: ${token.top10HolderRate}
Creator Status: ${token.creatorTokenStatus} | Creator Balance Rate: ${token.creatorBalanceRate}
Rug Ratio: ${token.rugRatio} | Bundler Rate: ${token.bundlerTraderAmountRate} | Insider Ratio: ${token.ratTraderAmountRate}
Is Wash Trading: ${token.isWashTrading}
Launchpad: ${token.launchpadPlatform}
Renounced Mint: ${token.renouncedMint} | Renounced Freeze: ${token.renouncedFreezeAccount}
Has Social: ${token.hasAtLeastOneSocial}
CTO Flag: ${token.ctoFlag}

K-line 1m last (30 candles):
${token.kline1mData}

K-line 5m last (12 candles):
${token.kline5mData}

Top Smart Degen Traders (holding/activity):
${token.topTradersSummary}

RELEVANT LEARNINGS from previous trades:
${relevantLearnings || "None"}
  `;
}
