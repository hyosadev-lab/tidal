# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**trading-agent** is an autonomous Solana memecoin trading agent that identifies promising post-graduation tokens, scores them using multi-signal analysis, and executes trades with AI-driven entry/exit decisions. The agent runs two concurrent loops: one that scans and evaluates token candidates, and another that monitors open positions for exit signals.

## Quick Start

### Installation and Running

```bash
# Install dependencies
bun install
# or
npm install

# Run in development (with watch mode)
npm run dev

# Run once
npm run start
```

### Environment Setup

1. Copy `.env.example` to `.env` and fill in required values:
   - GMGN API key and private key (for swap execution)
   - OpenRouter API key (for AI decisions)
   - Wallet address and trading parameters
   - Token filters (liquidity, holder count, etc.)
   - Exit parameters (stop-loss, trailing stop, max hold duration)

2. Optional: Place global config at `~/.config/gmgn/.env` (loaded first, then project `.env` overrides)

3. Set `DRY_RUN=true` to simulate trades without real transactions

## Architecture

### High-Level Flow

```
┌─────────────────────────────────────────┐
│         Main Event Loop                 │
├─────────────────────────────────────────┤
│                                         │
│  scanLoop (every SCAN_INTERVAL_SEC)    │  positionLoop (every POSITION_CHECK_INTERVAL_SEC)
│  ├─ Fetch graduated tokens (GMGN)      │  ├─ Check condition orders (stop-loss, trailing)
│  ├─ Filter by client-side rules        │  ├─ Check time limit
│  ├─ Enrich & score each token          │  ├─ AI evaluation (if needed)
│  ├─ AI entry decision (OpenRouter)     │  └─ Execute sell if triggered
│  ├─ Gate: check position capacity      │
│  └─ Execute buy (GMGN swap)            │
│                                         │
└─────────────────────────────────────────┘
```

### Signal Scoring System

Each token gets scored on three signals, combined into a **composite score** (0-100):

1. **Dip Recovery (70% weight)**: Scores based on:
   - Dip depth from all-time high (sweet spot: 50-70% below ATH)
   - Downtrend momentum (comparing recent lows vs older lows)
   - Buy volume dominance in last 5m
   - Buy transaction count dominance
   - Rejects: recent >100% spikes (dead cat bounce), extreme dips (>70%)

2. **Momentum (0% weight, disabled)**: Would score buy pressure, volume acceleration, and candle colors

3. **Smart Money (30% weight)**: Scores based on:
   - Number of active smart wallets (still holding)
   - Smart wallets with sufficient SOL balance
   - Recent entries (<5 minutes)
   - Average supply holdings per wallet
   - Rejected if all smart money has exited

**Gate**: Tokens below `MIN_SCORE_TO_BUY` are skipped.

### Entry Decision (AI)

OpenRouter/Claude evaluates the enriched token data and decides **BUY** or **SKIP** based on:
- Signal scores and their components
- Price action (ATH, current price, 5m/1h changes)
- Volume and liquidity metrics
- Developer/holder concentration
- Smart money activity
- Red flags from the model

**Gate**: Buys only if action is **BUY** AND confidence ≥ `AI_CONFIDENCE_THRESHOLD`.

### Position Management

Once a buy is confirmed:

1. **Condition Orders** (optional, set via env):
   - `STOP_LOSS_PCT`: Auto-sell if price drops X% from entry
   - `TRAILING_ACTIVATE_PCT` + `TRAILING_DRAWDOWN_PCT`: Activate trailing stop after +X%, then trail Y% from peak

2. **Time Limit**: Force close at `MAX_HOLD_DURATION_MINUTES` regardless of profit/loss

3. **AI Evaluation**: If condition orders don't fully cover exit (e.g., missing upside or downside), AI evaluates every `POSITION_CHECK_INTERVAL_SEC` and decides **SELL** or **HOLD**

### Database Schema

SQLite with tables:
- `signal_scores`: Raw score components for every evaluated token
- `ai_decisions`: Entry/position AI decisions with reasoning
- `trades`: Buy/sell order execution history
- `positions`: Open and closed positions with PnL
- `daily_stats`: Aggregated daily trading statistics

## Core Modules

### `src/modules/`

- **scanner.ts**: Fetches graduated tokens from GMGN API, applies client filters (owner renounced, wash trading check), deduplicates against open positions
- **scorer.ts**: Enriches token data (token info, klines, smart money holders), computes all three signal scores, gates on composite score, builds AI entry prompt
- **executor.ts**: Executes buy/sell swaps via GMGN, builds and submits condition orders, polls for confirmation, manages position records
- **position-manager.ts**: Main loop that checks open positions, mirrors condition orders (since GMGN doesn't return strategy_order_id), triggers AI exit decisions, closes positions with PnL calculation
- **ai-decision.ts**: Builds position snapshot and prompt for exit evaluation

### `src/services/`

- **gmgn-client.ts**: Wraps GMGN OpenAPI (token info, klines, smart money holders, swaps). Handles Ed25519 and RSA-SHA256 signing for authenticated requests
- **openrouter.ts**: Calls Claude 3 Haiku via OpenRouter for JSON-formatted entry and position decisions with structured reasoning
- **coingecko.ts**: Fetches current SOL/USD price for position management calculations

### `src/strategies/`

Each exports a scoring function and signal interface:
- **dip-recovery.ts**: `scoreDipRecovery()` — implements multi-component dip scoring with gates
- **momentum.ts**: `scoreMomentum()` — buy pressure, volume acceleration, candle color analysis
- **smart-money.ts**: `scoreSmartMoney()` — smart wallet activity scoring with all-exit gate

### `src/db/`

- **database.ts**: SQLite setup, WAL mode, migration runner
- **queries.ts**: Typed query builders for all operations (insert trades, positions, decisions; fetch open positions; update position status; daily stats aggregation)

### `src/utils/`

- **logger.ts**: Winston logger to console + `logs/agent.log` + `logs/error.log`
- **math.ts**: SOL/lamports conversion, PnL calculations, time formatting, Solscan URL builders
- **retry.ts**: Exponential backoff retry utility for API calls

## Configuration

All config from environment variables (type-checked in `src/config.ts`):

**Core Trading**:
- `TRADE_SIZE_SOL`: Amount per buy
- `MAX_CONCURRENT_POSITIONS`: Position capacity
- `SCAN_INTERVAL_SEC`, `POSITION_CHECK_INTERVAL_SEC`: Loop frequencies

**Thresholds**:
- `MIN_SCORE_TO_BUY`: Composite score gate (0-100)
- `AI_CONFIDENCE_THRESHOLD`: Confidence gate for AI decisions (0-1)

**Exit Strategy** (optional):
- `STOP_LOSS_PCT`, `TRAILING_ACTIVATE_PCT`, `TRAILING_DRAWDOWN_PCT`, `MAX_HOLD_DURATION_MINUTES`

**Token Filters** (server-side via GMGN):
- Liquidity, holder count, top-holder concentration, rug ratio, token age, market cap, etc.

**Execution**:
- `SLIPPAGE`, `AUTO_SLIPPAGE`, `ANTI_MEV`: Swap parameters
- `DRY_RUN`: Set to `true` for simulation

See `.env.example` for full list and descriptions.

## Key Implementation Details

### Composite Scoring Weights

Currently: **70% dip recovery + 0% momentum + 30% smart money**

The momentum score is computed but not used in the composite. To enable:
```typescript
// src/modules/scorer.ts, line ~92
const composite =
  dip.score * 0.70 +
  momentum.score * 0.30 +  // Change from 0 to desired weight
  smartMoney.score * 0;     // Adjust other weights
```

### Condition Order Mirroring

GMGN doesn't return `strategy_order_id` in swap responses, so we can't poll condition order status. Instead, we **mirror the logic client-side** in `position-manager.ts`:
- Compare current price to entry price and peak price
- Trigger "STOP_LOSS" or "TRAILING_STOP" reasons when thresholds hit
- In live mode, the condition order fires on-chain; we sync DB. In dry-run, we simulate.

### AI Decision Format

Expects JSON responses with this shape:

```typescript
// Entry decision
{ action: "BUY" | "SKIP", confidence: number, reasoning: string, red_flags: string[] }

// Position decision
{ action: "HOLD" | "SELL", confidence: number, reasoning: string }
```

Both are retry-wrapped and parse-error tolerant (fallback on JSON parse failure).

### Dry-Run Simulation

Set `DRY_RUN=true` to:
- Skip real swap execution
- Simulate buy/sell at current GMGN prices
- Use condition order thresholds locally instead of on-chain
- Record everything to database as if live

Useful for backtesting strategy parameters before going live.

## Development Workflow

### Testing Changes to Scoring Logic

1. Adjust thresholds in strategy files (`src/strategies/*.ts`)
2. Run in `DRY_RUN=true` mode to see scoring output
3. Check `logs/agent.log` for token evaluations and signal breakdowns
4. Adjust weights in `src/modules/scorer.ts` composite calculation
5. Restart agent to apply changes

### Adding New Filters

Client-side filters in `src/modules/scanner.ts` `passesClientFilter()`:
```typescript
if (condition) {
  logger.warn('token_skipped', { mint, symbol, reason: 'your_reason' });
  return false;
}
```

Server-side filters set via env vars in `.env` (validated by GMGN API).

### Adding New Signal

1. Create `src/strategies/your-signal.ts` with scoring function and interface
2. Import in `src/modules/scorer.ts`
3. Compute score and add to `AllSignalScores` interface
4. Update composite calculation
5. Add signal details to database insert and AI prompt

### Monitoring Live Runs

```bash
# Watch agent logs in real-time
tail -f logs/agent.log

# Check errors
tail -f logs/error.log

# Query database (opens SQLite shell)
sqlite3 data/trading-agent.db
```

Common queries:
```sql
-- Recent entries
SELECT * FROM ai_decisions WHERE decision_type='entry' ORDER BY decided_at DESC LIMIT 10;

-- Open positions
SELECT * FROM positions WHERE status='open';

-- Today's PnL
SELECT * FROM daily_stats WHERE date=date('now');
```

## Dependencies and Versions

- **TypeScript 5.3+**: Strict mode, ESNext target
- **tsx 4.7+**: TypeScript execution (supports `.ts` imports)
- **better-sqlite3 9.6+**: Synchronous SQLite (no async needed for agent)
- **winston 3.11+**: Structured logging
- **dotenv 16.4+**: Env var loading
- **Node 20+ or Bun 1.3+**: Runtime

## Build and Output

- **No build step needed**: `tsx` runs TypeScript directly
- **Output**: Logs to `logs/` directory, database to `data/trading-agent.db`
- **Artifacts**: Store trades, positions, and decisions in SQLite for audit trail

## Common Patterns

### Accessing Config
```typescript
import { getConfig } from './config.ts';
const config = getConfig(); // Singleton, safe to call multiple times
```

### Logging Structured Events
```typescript
logger.info('event_name', { key: value, mint: token.address });
logger.warn('warning_event', { reason: 'description' });
logger.error('error_event', { error: String(err) });
```

### Retry with Backoff
```typescript
import { withRetry } from './utils/retry.ts';
const result = await withRetry(() => apiCall(), { maxAttempts: 3, baseDelayMs: 2000 });
```

### Converting Prices
```typescript
import { solToLamports, lamportsToSol, computePnlPct } from './utils/math.ts';
const lamports = solToLamports(0.1); // For GMGN input_amount
const sol = lamportsToSol(lamports);
const pnlPct = computePnlPct(entryPrice, exitPrice);
```

## Troubleshooting

- **No tokens scored**: Check `MIN_SCORE_TO_BUY` is not too high; verify signal scoring gates (dip range, dead cat bounce, smart money exit)
- **Condition orders not triggering**: In dry-run, verify thresholds in `checkConditionOrderMirror()`; in live mode, check GMGN condition order status manually
- **AI decisions seem wrong**: Review model choice (`OPENROUTER_MODEL` env var); temperature is 0.1 (deterministic); check reasoning in logs
- **Database locked**: SQLite WAL mode should handle concurrent access; if stuck, restart agent (closes DB handle)

