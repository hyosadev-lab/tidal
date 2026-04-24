# Volume Calculation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add volume delta calculation per candle to improve AI entry timing decisions.

**Architecture:** Create a dedicated kline utility module to parse GMGN kline data and calculate volume metrics, then integrate into the AI decision prompt.

**Tech Stack:** TypeScript, Bun

---

### Task 1: Create kline utility module

**Files:**
- Create: `src/utils/kline.ts`
- Test: `src/utils/kline.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { calculateVolumeDeltas, parseKlineData } from "./kline";

describe("kline utils", () => {
  test("parseKlineData parses JSON string to array", () => {
    const klineString = JSON.stringify([[1700000000, 1, 2, 3, 4, 100]]);
    const result = parseKlineData(klineString);
    expect(result).toEqual([[1700000000, 1, 2, 3, 4, 100]]);
  });

  test("parseKlineData handles empty string", () => {
    const result = parseKlineData("");
    expect(result).toEqual([]);
  });

  test("calculateVolumeDeltas returns formatted string with deltas", () => {
    const klines = [
      [1700000000, 1, 2, 3, 4, 100],
      [1700000060, 1, 2, 3, 4, 200],
      [1700000120, 1, 2, 3, 4, 150],
    ];
    const result = calculateVolumeDeltas(klines, 3);
    expect(result).toContain("+100%");
    expect(result).toContain("-25%");
  });

  test("calculateVolumeDeltas handles single candle", () => {
    const klines = [[1700000000, 1, 2, 3, 4, 100]];
    const result = calculateVolumeDeltas(klines, 1);
    expect(result).toContain("N/A");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/utils/kline.test.ts`
Expected: FAIL with "module not found" or "function not defined"

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/utils/kline.ts

/**
 * Parse kline JSON string to array
 */
export function parseKlineData(klineString: string): number[][] {
  if (!klineString) return [];
  try {
    const parsed = JSON.parse(klineString);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Calculate volume deltas for last N candles
 * Returns formatted string: "Volume Deltas: +100%, -25%, +50%"
 */
export function calculateVolumeDeltas(klines: number[][], limit: number): string {
  if (klines.length < 2) {
    return "Volume Deltas: N/A (insufficient data)";
  }

  const deltas: string[] = [];
  const startIdx = Math.max(0, klines.length - limit);

  for (let i = startIdx + 1; i < klines.length; i++) {
    const prevVolume = klines[i - 1][5]; // volume is at index 5
    const currVolume = klines[i][5];

    if (prevVolume === 0) {
      deltas.push("N/A");
      continue;
    }

    const deltaPercent = ((currVolume - prevVolume) / prevVolume) * 100;
    const sign = deltaPercent >= 0 ? "+" : "";
    deltas.push(`${sign}${deltaPercent.toFixed(1)}%`);
  }

  return `Volume Deltas (${limit} candles): ${deltas.join(", ")}`;
}

/**
 * Get volume deltas from kline JSON string
 */
export function getVolumeDeltasFromKline(klineString: string, limit: number = 5): string {
  const klines = parseKlineData(klineString);
  return calculateVolumeDeltas(klines, limit);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/utils/kline.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/utils/kline.ts src/utils/kline.test.ts
git commit -m "feat: add kline volume delta calculation utility"
```

### Task 2: Integrate volume deltas into AI decision prompt

**Files:**
- Modify: `src/agent/decision.ts`

- [ ] **Step 1: Import kline utility**

Add to imports in `src/agent/decision.ts`:

```typescript
import { getVolumeDeltasFromKline } from "../utils/kline";
```

- [ ] **Step 2: Update buildUserPrompt function**

Modify `buildUserPrompt` function to include volume deltas:

```typescript
function buildUserPrompt(
  token: TokenData,
  learnings: Learning[]
): string {
  const relevantLearnings = learnings
    .filter((l) => l.pattern.type === "entry" || l.pattern.type === "filter")
    .map((l) => l.insight)
    .join("\n");

  // Calculate volume deltas for both timeframes
  const volumeDeltas1m = getVolumeDeltasFromKline(token.kline1mData, 5);
  const volumeDeltas5m = getVolumeDeltasFromKline(token.kline5mData, 5);

  return `
TOKEN: ${token.symbol} (${token.address})
Market Cap: $${token.usdMarketCap}
Liquidity: $${token.liquidity}
Volume 1h: $${token.volume1h.toFixed(2)} | Swaps 1h: ${token.swaps1h}
Price Change 1h: ${token.priceChange1h}%
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

${volumeDeltas1m}

K-line 5m last (12 candles):
${token.kline5mData}

${volumeDeltas5m}

Top Smart Degen Traders (holding/activity):
${token.topTradersSummary}

RELEVANT LEARNINGS from previous trades:
${relevantLearnings || "None"}

ANALYZE MOMENTUM:
- Is volume 1h significantly higher than average?
- Is price change 1h positive and accelerating?
- Are smart degen traders actively buying (holding >0.5 SOL)?
- Are there recent volume spikes (positive deltas) indicating entry momentum?
  `;
}
```

- [ ] **Step 3: Run type check**

Run: `bun run typecheck` or `bun build src/agent/decision.ts`
Expected: No type errors

- [ ] **Step 4: Run tests**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/agent/decision.ts
git commit -m "feat: integrate volume delta metrics into AI decision prompt"
```

### Task 3: Verify implementation with dry run

**Files:**
- No file changes needed

- [ ] **Step 1: Run dry run mode**

Run: `DRY_RUN=true bun run src/index.ts`
Expected: Agent runs without errors, logs show volume deltas in prompt

- [ ] **Step 2: Check logs for volume delta output**

Monitor logs to confirm volume deltas are being calculated and included in AI context.

- [ ] **Step 3: Commit verification**

```bash
git commit --allow-empty -m "chore: verify volume delta integration in dry run"
```

---

## Self-Review

**1. Spec coverage:**
- ✅ Parse kline strings in `decision.ts` → Done via `getVolumeDeltasFromKline` utility
- ✅ Calculate volume delta % for last N candles → Done with configurable limit
- ✅ Add to AI prompt as structured text → Done in `buildUserPrompt`
- ✅ Keep fallback logic unchanged → Fallback logic untouched

**2. Placeholder scan:**
- ✅ No TBD/TODO placeholders
- ✅ All code blocks complete
- ✅ All commands exact

**3. Type consistency:**
- ✅ `parseKlineData` returns `number[][]`
- ✅ `calculateVolumeDeltas` accepts `number[][]`
- ✅ `getVolumeDeltasFromKline` accepts `string` and `number`
- ✅ All function signatures consistent across tasks

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2025-04-25-volume-calculation-implementation.md`.

**Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
