import type { Position, Learning, TokenData } from "../storage/types";
import { logger } from "../utils/logger";
import { getRelevantPatterns } from "./learner";

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "openrouter/elephant-alpha";
const TEMPERATURE = parseFloat(process.env.TEMPERATURE || "0.3");
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || "5000", 10);

const SYSTEM_PROMPT = `
You are an elite Solana memecoin trader. You manage open positions in the "Trenches" (tokens $20K–$2M market cap).

YOUR EDGE: Cut losses fast, let winners run. No profit cap. Let momentum carry profits to +50%, +100%, or beyond — but PROTECT gains when data shows weakness.

DECISION RULES (strict priority):

SELL IMMEDIATELY:
- PnL <= -25% → hard stop loss. No exceptions. No "wait and see".
- Rug/wash trading/insider dump detected at ANY PnL.
- Smart money actively distributing (negative net flow, more sells than buys) at ANY PnL.
- Token age > 30m with negative price trend and declining volume.

SELL IF PROFITABLE + WEAKNESS:
- PnL >= +15% AND any exit signal detected (distribution, volume fade, momentum shift, smart money selling).
- PnL >= +15% AND buy/sell ratio dropping below 1.0.
- PnL >= +15% AND smart money net flow turning negative.
- Unprofitable for >9 minutes with no recovery signs.

HOLD:
- PnL between -25% and +15% AND no exit signals.
- PnL > +15% AND momentum intact (strong buy pressure, smart money accumulating, volume healthy).
- PnL negative BUT showing recovery signs (volume picking up, smart money buying).

KEY MENTALITY:
- Losses: CUT FAST. A -15% loss taken is better than -30% that becomes -40%.
- Profits: LET RUN if strong, LOCK if weakening. A +20% gain secured beats a +40% that fades to -10%.
- Never hope for recovery. React to current data.

You learn from every decision — past learnings are provided and should influence your judgment.

Respond ONLY in JSON:
{
  "action": "HOLD" | "SELL",
  "confidence": 0-100,
  "reasoning": "2-3 sentences, cite actual numbers",
  "signals": ["signal1", "signal2"],
  "risk_flags": ["flag1"]
}
`;

interface AiManageDecision {
  action: "HOLD" | "SELL";
  confidence: number;
  reasoning: string;
  signals: string[];
}

export async function getManageDecision(
  position: Position,
  tokenData: TokenData, // Current market data
  learnings: Learning[]
): Promise<AiManageDecision> {
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
  // Use new pattern scoring system from learner.ts for SELL/HOLD decisions
  // Include both SELL and HOLD patterns (exit timing, hold loss patterns, etc.)
  const relevantPatterns = getRelevantPatterns(learnings, ["SELL", "HOLD"])

  // Separate patterns by type for better display
  const holdLossPatterns = relevantPatterns.filter(p => p.type === "hold_loss");
  const exitPatterns = relevantPatterns.filter(p => p.type === "exit" || p.type === "timing" || p.type === "hold" || p.type === "volume");

  const holdLossText = holdLossPatterns.length > 0
    ? holdLossPatterns.map(p => {
        const scoreIcon = (p.confidence || 0) > 70 ? "🟢" : (p.confidence || 0) > 40 ? "🟡" : "🔴";
        return `${scoreIcon} [HOLD LOSS WARNING] ${p.description} (${p.successRate}% loss rate, avg ${p.avgPnlPercent?.toFixed(1)}% loss)`;
      }).join("\n")
    : "None detected";

  const exitPatternsText = exitPatterns.length > 0
    ? exitPatterns.map(p => {
        const scoreIcon = (p.confidence || 0) > 70 ? "🟢" : (p.confidence || 0) > 40 ? "🟡" : "🔴";
        return `${scoreIcon} [${p.type.toUpperCase()}] ${p.description} (${p.successRate}% success, ${p.avgPnlPercent > 0 ? "+" : ""}${p.avgPnlPercent?.toFixed(1)}% avg PnL)`;
      }).join("\n")
    : "None";

  const holdingMs = Date.now() - position.entryTimestamp;
  const holdingMin = Math.floor(holdingMs / 60000);
  const phase = holdingMin < 5 ? "EARLY (0-5m)"
    : holdingMin < 15 ? "ACTIVE (5-15m)"
    : "LATE (15m+)";

  return `
POSITION: ${position.tokenSymbol} | Phase: ${phase} | Holding: ${holdingMin}m
PnL: ${position.unrealizedPnlPercent?.toFixed(2)}% (${position.unrealizedPnlSol?.toFixed(4)} SOL)
Entry: $${position.entryPrice.toFixed(8)} → Now: $${position.currentPrice?.toFixed(8)}

━━━ PRICE & ORDER FLOW ━━━
Price: $${tokenData.price.toFixed(8)}
Intensity: ${(tokenData.orderFlowSummary?.intensity || "neutral").toUpperCase()}
Net Flow: $${tokenData.orderFlowSummary.netFlowUsd.toFixed(2)}
Buy/Sell Ratio: ${tokenData.orderFlowSummary.buySellRatio.toFixed(2)}x
Buy: $${tokenData.orderFlowSummary.buyVolume.toFixed(2)} | Sell: $${tokenData.orderFlowSummary.sellVolume.toFixed(2)}

━━━ SMART MONEY ━━━
Net Flow: $${tokenData.orderFlowSummary.smartMoneyNetFlow.toFixed(2)}
Buys: ${tokenData.orderFlowSummary.smartMoneyBuyCount} | Sells: ${tokenData.orderFlowSummary.smartMoneySellCount}
Active Smart Degens: ${tokenData.activeSmartDegenCount} (entry: ${position.activeSmartDegenEntryCount ?? "N/A"})
${tokenData.topTradersSummary}

━━━ ON-CHAIN FLOW ━━━
${tokenData.volumeDeltas1m}

${tokenData.cvdProxy}

${tokenData.candlePatterns}

${tokenData.volumeProfile}

━━━ RISK ━━━
Rug: ${tokenData.rugRatio.toFixed(3)} ${tokenData.rugRatio > 0.7 ? "⚠️ HIGH" : tokenData.rugRatio > 0.3 ? "🟡 MEDIUM" : "🟢 LOW"} | Wash: ${tokenData.isWashTrading} | Creator: ${tokenData.creatorTokenStatus}
Sniper: ${tokenData.sniperCount} | Fresh: ${((tokenData.freshWalletRate ?? 0) * 100).toFixed(1)}% | Insider: ${((tokenData.insiderHoldRate ?? 0) * 100).toFixed(1)}%
Token Age: ${Math.floor((tokenData.tokenAgeSecs ?? 0) / 60)}m

━━━ EXIT PATTERNS ━━━
${exitPatternsText}

━━━ HOLD LOSS WARNINGS ━━━
${holdLossText}

Analyze order flow. SELL if distribution detected. HOLD if momentum intact.`;
}
