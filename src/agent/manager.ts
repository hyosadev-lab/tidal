import { Position, Learning, TokenData } from "../storage/types";

const SYSTEM_PROMPT = `
Kamu adalah expert crypto trader yang spesialis di Solana memecoin "Trenches".
Tugasmu mengevaluasi posisi yang sedang dipegang dan memutuskan apakah harus HOLD atau SELL.
Jawab HANYA dalam format JSON: { "action": "HOLD"|"SELL", "confidence": 0-100, "reasoning": "...", "signals": ["signal1", ...] }
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

  // 3. Call OpenRouter (mocked for now)
  // Simple rule-based logic for demonstration
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
POSISI: ${position.tokenSymbol} (${position.tokenAddress})
Entry Price: $${position.entryPrice} | Entry Market Cap: $${position.entryMarketCap}
Current Price: $${tokenData.price} | Current Market Cap: $${tokenData.marketCap}
Unrealized PnL: ${position.unrealizedPnlPercent}% ($${position.unrealizedPnlUsd})
Holding Duration: ${holdingDurationHuman}
Cost: $${position.costUsd}

Market Data Terkini:
Volume 1h: $${tokenData.volume1h} | Swaps 1h: ${tokenData.swaps1h}
Smart Degen Count: ${tokenData.smartDegenCount} (saat entry: N/A) // Simplified for now
Holder Count: ${tokenData.holderCount}
Rug Ratio: ${tokenData.rugRatio}
Creator Status: ${tokenData.creatorTokenStatus}
Is Wash Trading: ${tokenData.isWashTrading}

K-line 1m terakhir (5 candle):
${tokenData.klineData}

Take Profit target: +${takeProfitPercent}%
Stop Loss target: -${stopLossPercent}%

LEARNINGS dari trade sebelumnya yang relevan:
${relevantLearnings || "None"}
  `;
}
