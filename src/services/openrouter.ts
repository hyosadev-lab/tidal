import { getConfig } from '../config.ts';
import { logger } from '../utils/logger.ts';
import { withRetry } from '../utils/retry.ts';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export interface EntryDecision {
  action: 'BUY' | 'SKIP';
  confidence: number;
  reasoning: string;
  red_flags: string[];
}

export interface PositionDecision {
  action: 'HOLD' | 'SELL';
  confidence: number;
  reasoning: string;
}

async function callOpenRouter(
  systemPrompt: string,
  userPrompt: string,
  rawResponseOut?: { raw: string }
): Promise<string> {
  const config = getConfig();

  const response = await withRetry(
    async () => {
      const res = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.openrouterApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.openrouterModel,
          max_tokens: 4096,
          temperature: 0.1,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`OpenRouter HTTP ${res.status}: ${text}`);
      }

      return res;
    },
    { maxAttempts: 2, baseDelayMs: 2000 }
  );

  const data = await response.json() as any;
  const content = data?.choices?.[0]?.message?.content ?? '';

  if (rawResponseOut) rawResponseOut.raw = content;
  return content;
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    const clean = raw.replace(/```json|```/g, '').trim();
    return JSON.parse(clean) as T;
  } catch {
    return fallback;
  }
}

// ─── Entry Evaluation ─────────────────────────────────────────────────────────

const ENTRY_SYSTEM_PROMPT = `You are a professional Solana memecoin trader specializing in post-graduation tokens.
You will receive structured market data and signal scores for a token candidate.
Decide: BUY or SKIP.

Rules:
- Output ONLY valid JSON — no preamble, no markdown, nothing outside the JSON.
- A high composite score with red flags (high holder concentration, dev holding, wash trading) is still SKIP.
- Trust smart_degen presence as a strong confirming signal.
- confidence < 0.6 → always SKIP.

Output format:
{
  "action": "BUY" | "SKIP",
  "confidence": 0.0–1.0,
  "reasoning": "one paragraph max",
  "red_flags": ["array of concerns, empty if none"]
}`;

export async function evaluateEntry(userPrompt: string): Promise<EntryDecision> {
  const rawOut = { raw: '' };

  try {
    const content = await callOpenRouter(ENTRY_SYSTEM_PROMPT, userPrompt, rawOut);
    const parsed = parseJson<Partial<EntryDecision>>(content, {});

    const decision: EntryDecision = {
      action: parsed.action === 'BUY' ? 'BUY' : 'SKIP',
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
      reasoning: parsed.reasoning ?? 'No reasoning provided',
      red_flags: Array.isArray(parsed.red_flags) ? parsed.red_flags : [],
    };

    return { ...decision, _raw: rawOut.raw } as any;
  } catch (err) {
    logger.error('ai_entry_error', { error: String(err) });
    // Safe fallback: SKIP on error
    return { action: 'SKIP', confidence: 0, reasoning: `AI error: ${err}`, red_flags: ['ai_error'] };
  }
}

// ─── Position Evaluation ──────────────────────────────────────────────────────

const POSITION_SYSTEM_PROMPT = `You are a professional Solana memecoin trader managing an open position.
You will receive the current state of a token you are holding.
Decide: HOLD or SELL.

Rules:
- Output ONLY valid JSON.
- SELL if: smart money is exiting, volume is collapsing, holder count declining, or momentum clearly reversed.
- HOLD if: fundamentals still intact, or token showing signs of further upside.
- You may SELL below take-profit target if risk/reward has deteriorated.
- confidence < 0.6 → HOLD (when in doubt, let the position run).

Output format:
{
  "action": "HOLD" | "SELL",
  "confidence": 0.0–1.0,
  "reasoning": "one paragraph max"
}`;

export async function evaluatePosition(userPrompt: string): Promise<PositionDecision> {
  const rawOut = { raw: '' };

  try {
    const content = await callOpenRouter(POSITION_SYSTEM_PROMPT, userPrompt, rawOut);
    const parsed = parseJson<Partial<PositionDecision>>(content, {});

    const decision: PositionDecision = {
      action: parsed.action === 'SELL' ? 'SELL' : 'HOLD',
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
      reasoning: parsed.reasoning ?? 'No reasoning provided',
    };

    // confidence < 0.6 → HOLD
    if (decision.confidence < 0.6 && decision.action === 'SELL') {
      decision.action = 'HOLD';
      decision.reasoning = `[Low confidence override] ${decision.reasoning}`;
    }

    return { ...decision, _raw: rawOut.raw } as any;
  } catch (err) {
    logger.error('ai_position_error', { error: String(err) });
    // Safe fallback: HOLD on error (don't panic sell)
    return { action: 'HOLD', confidence: 0, reasoning: `AI error: ${err}` };
  }
}
