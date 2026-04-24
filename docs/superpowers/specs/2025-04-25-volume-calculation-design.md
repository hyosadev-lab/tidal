# Volume Calculation Design for AI Entry Timing

## Objective
Improve AI entry timing by calculating volume metrics per candle (volume delta) and including them in the AI prompt context. This allows the AI to identify momentum spikes and volume surges for better BUY/SKIP decisions.

## Approach
1. **Parse kline strings** in `src/agent/decision.ts` (currently raw strings in `TokenData.kline1mData` and `kline5mData`).
2. **Calculate volume delta %** for the last N candles (e.g., 5 candles) using relative change from previous candle.
3. **Structure the data** into a readable format for the AI prompt.
4. **Update the AI prompt** to include volume delta metrics.
5. **Keep fallback logic** unchanged for backward compatibility.

## Implementation Steps
- Update `buildUserPrompt()` in `src/agent/decision.ts` to parse kline data and compute volume deltas.
- Add new helper function `calculateVolumeDeltas(klineData: string, limit: number): string`.
- Format output as: "Volume Delta 1m: +150%, +50%, -20%, ..." for last 5 candles.
- Ensure error handling for malformed kline strings.

## Trade-offs
- **Pros**: Precise entry timing, momentum detection, AI understands volume trends.
- **Cons**: Slightly more processing overhead, parsing complexity.

## Approval
Design approved by user on 2025-04-25.
