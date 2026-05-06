# CLAUDE.md — Tidal

Autonomous Solana memecoin trading agent that monitors "Trenches" tokens ($20K–$2M market cap), makes AI-driven buy/sell decisions, and learns from every trade through an event-driven feedback loop.

---

## Stack

- **Runtime**: Bun (bukan Node.js)
- **Bahasa**: TypeScript strict mode
- **Data Storage**: File JSON lokal (`data/` directory) dengan mutex locking
- **Market Data & Eksekusi**: `gmgn-cli@1.2.8` (subprocess)
- **AI Decision Engine**: OpenRouter API — model: `google/gemini-2.5-flash-lite`
- **Target**: Token Trenches Solana (Pump.fun, pump_agent) — market cap $20K–$2M+

---

## Struktur Direktori

```
tidal/
├── CLAUDE.md
├── README.md
├── .env                       # API keys & config (JANGAN di-commit)
├── .env.example               # Template env vars
├── .gitignore
├── package.json
├── tsconfig.json
├── bun.lock
├── src/
│   ├── index.ts               # Entry point — graceful shutdown + parallel sessions
│   ├── agent/
│   │   ├── decision.ts        # AI Screening: BUY/SKIP decision
│   │   ├── manager.ts         # AI Managing: HOLD/SELL decision
│   │   └── learner.ts         # Event-driven learning (every 30 decisions)
│   ├── sessions/
│   │   ├── screening.ts       # Token discovery loop
│   │   └── managing.ts        # Position monitoring loop
│   ├── gmgn/
│   │   ├── client.ts          # Wrapper gmgn-cli subprocess (rate limited)
│   │   ├── trenches.ts        # Fetch trenches tokens
│   │   ├── market.ts          # Market data (kline, token info, security, order flow)
│   │   └── trade.ts           # Execute swap, query order
│   ├── storage/
│   │   ├── db.ts              # JSON file read/write dengan mutex locking
│   │   └── types.ts           # Semua TypeScript interfaces
│   └── utils/
│       ├── concurrency.ts     # Delay utility
│       ├── kline.ts           # Technical analysis (volume deltas, candlestick, CVD, volume profile)
│       ├── kline.test.ts      # Tests untuk kline utils
│       ├── logger.ts          # Structured logging
│       ├── stats.ts           # Performance display CLI
│       └── helpers.ts         # Auth utils, UUID, dll
└── data/
    ├── trades.json            # History semua trades
    ├── positions.json         # Open positions saat ini
    ├── decisions.json         # Decision records dengan rich context
    ├── learnings.json         # Pattern & insight dari decisions
    ├── learning_state.json    # Learning trigger state
    ├── performance.json       # Metrics performa
    └── sold_tokens.json       # Cooldown tracking untuk token yang sudah dijual
```

---

## Environment Variables

```env
# GMGN API
GMGN_API_KEY=your_gmgn_api_key
GMGN_PRIVATE_KEY=your_private_key_for_trade_signing
GMGN_WALLET_ADDRESS=your_wallet_address
GMGN_CHAIN=sol

# OpenRouter
OPENROUTER_API_KEY=your_openrouter_api_key
OPENROUTER_MODEL=google/gemini-2.5-flash-lite

# Trading Config
MAX_OPEN_POSITIONS=3               # Maks posisi terbuka sekaligus
SCAN_INTERVAL_MINUTES=1            # Screening: scan trenches setiap 1 menit
MANAGE_INTERVAL_MINUTES=0.5        # Managing: monitor posisi setiap 30 detik
SLIPPAGE=0.15                      # 15% slippage untuk trenches
AMOUNT_SOL=0.2                     # Jumlah SOL untuk setiap buy order
SOLD_COOLDOWN_MINUTES=1            # Skip token yang baru dijual

# GMGN Trenches Parameters
GMGN_SORT_BY=swaps_1h              # Sort: smart_degen_count, volume_24h, swaps_1h, dll
GMGN_LIMIT=10                      # Max tokens to return
GMGN_TYPE=completed                # Type: new_creation, near_completion, completed
GMGN_LAUNCHPAD_PLATFORM=Pump.fun,pump_agent  # Launchpad filter

# GMGN Trenches Filters
GMGN_FILTER_PRESET=                # safe | smart-money | strict
GMGN_MIN_USD_MARKET_CAP=30000
GMGN_MAX_CREATED=120m              # Max token age
GMGN_MIN_SMART_DEGEN_COUNT=3
GMGN_MIN_RENOWNED_COUNT=2
GMGN_MAX_INSIDER_RATIO=0.10
GMGN_MAX_CREATOR_BALANCE_RATE=0.11

# GMGN Trenches Filters (Server-side) — min & max untuk semua filter
GMGN_MIN_*=                        # Minimal *
GMGN_MAX_*=                        # Maximal *

# Agent
DRY_RUN=true                       # true = simulasi, false = live trading
TEMPERATURE=0.15                   # AI exploration level (0-1)
MAX_TOKENS=2500                    # Max tokens untuk AI response
LOG_LEVEL=info
```

---

## GMGN CLI — Endpoints

Semua calls melalui `src/gmgn/client.ts` wrapper. Rate limited 100ms antar request.

**1. Trenches — scan token baru**
```
gmgn-cli market trenches --chain sol --type completed --filter-preset safe --min-smart-degen-count 1 --raw
```

**2. K-line data (candlestick)**
```
gmgn-cli market kline --chain sol --address <token_address> --resolution 1m --from <timestamp> --to <timestamp> --raw
```

**3. Token Top Traders (Smart Money)**
```
gmgn-cli token traders --chain sol --address <token_address> --tag smart_degen --limit 10 --raw
```

**4. Token Info**
```
gmgn-cli token info --chain sol --address <token_address> --raw
```

**5. Token Security**
```
gmgn-cli token security --chain sol --address <token_address> --raw
```

**6. Execute Swap (BUY/SELL)**
```
gmgn-cli swap --chain sol --from <wallet> --input-token <input> --output-token <output> --amount <amount> --slippage <slippage>
```

**7. Query Order Status**
```
gmgn-cli order get --chain sol --order-id <order_id> --raw
```

---

## Data Storage Schema

### `data/trades.json`

```typescript
interface Trade {
  id: string;                       // UUID
  tokenAddress: string;
  tokenSymbol: string;
  tokenName: string;
  action: "BUY" | "SELL";
  inputAmount: string;              // amount dalam minimum unit
  inputAmountSol: number;           // SOL amount
  outputAmount: string;
  priceAtTrade: number;
  marketCapAtTrade: number;
  timestamp: number;                // Unix ms
  orderId: string;
  orderStatus: "pending" | "confirmed" | "failed" | "expired";
  txHash?: string;
  isDryRun: boolean;

  // Diisi saat SELL
  entryPrice?: number;
  entryMarketCap?: number;
  exitPrice?: number;
  exitMarketCap?: number;
  pnlSol?: number;                 // PnL dalam SOL
  pnlPercent?: number;
  holdingDurationMs?: number;
  exitReason?: string;             // "shutdown", "ai_decision", dll

  // AI context saat decision
  aiReasoning?: string;
  signalsUsed?: string[];
}
```

### `data/positions.json`

```typescript
interface Position {
  tokenAddress: string;
  tokenSymbol: string;
  tokenName: string;
  entryPrice: number;
  entryMarketCap: number;
  entryTimestamp: number;
  amountToken: string;              // jumlah token yang dipegang
  costSol: number;                  // total biaya dalam SOL
  currentPrice?: number;            // update periodik
  currentMarketCap?: number;
  unrealizedPnlSol?: number;
  unrealizedPnlPercent?: number;
  lastUpdated: number;
  buyTradeId: string;
  buyDecisionId?: string;           // Reference ke BUY decision
  smartDegenEntryCount?: number;    // total smart wallets at entry
  activeSmartDegenEntryCount?: number; // active smart degens at entry
  peakPrice?: number;               // Trailing stop data
  peakPriceTimestamp?: number;
  lastHoldDecisionId?: string;      // Reference ke HOLD decision terakhir
}
```

### `data/learnings.json`

```typescript
interface Learning {
  id: string;
  createdAt: number;
  basedOnTradeIds: string[];
  patterns: PatternAnalysis[];
  insights: string;                 // AI-generated summary
}

interface PatternAnalysis {
  type: "entry" | "exit" | "risk" | "filter" | "timing" | "volume" | "hold" | "hold_loss" | "missed_opportunity";
  description: string;
  successRate: number;
  avgPnlPercent: number;
  appliedCount: number;
  successCount: number;
  recencyWeight?: number;           // 0-1, berdasarkan usia pattern
  confidence?: number;              // Weighted composite score
  examples?: string[];              // Token addresses yang matched
}
```

### `data/performance.json`

```typescript
interface Performance {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalPnlSol: number;
  avgWinPercent: number;
  avgLossPercent: number;
  largestWinSol: number;
  largestLossSol: number;
  avgHoldingHours: number;
  lastUpdated: number;
  dailyStats: Record<string, { pnl: number; trades: number; wins: number }>;
}
```

### `data/decisions.json`

```typescript
interface DecisionRecord {
  id: string;                       // UUID
  tokenAddress: string;
  tokenSymbol: string;
  decisionType: "BUY" | "SELL" | "HOLD" | "SKIP";
  timestamp: number;
  confidence: number;               // 0-100
  reasoning: string;
  signals: string[];
  outcome: "success" | "failure" | "pending" | "executed" | "skipped";
  outcomeDetails?: DecisionOutcomeDetails;
  aiReasoning?: string;
  context?: DecisionContext;        // Rich context untuk learning
}

interface DecisionOutcomeDetails {
  pnlSol?: number;
  pnlPercent?: number;
  exitReason?: string;
  holdingDurationMs?: number;
  orderId?: string;
  orderStatus?: string;
  txHash?: string;
  error?: string;
  linkedDecisionId?: string;        // Untuk HOLD→SELL linking
  holdOutcome?: "profit" | "loss" | "breakeven" | "uncertain";
}

interface DecisionContext {
  priceAtTrade?: number;
  marketCapAtTrade?: number;
  inputAmountSol?: number;
  entryPrice?: number;
  exitPrice?: number;
  isDryRun?: boolean;
  orderFlowIntensity?: "bullish" | "bearish" | "neutral";
  volume1h?: number;
  smartDegenCount?: number;
  rugRatio?: number;
  liquidity?: number;
  cvdTrend?: "rising" | "falling" | "flat";
  volumeAcceleration?: number;
  hasCandleBreakout?: boolean;
  hasUpperWickDominance?: boolean;
  freshWalletRate?: number;
  sniperCount?: number;
  tokenAgeMins?: number;
}
```

### `data/sold_tokens.json`

```typescript
interface SoldToken {
  address: string;
  symbol: string;
  soldAt: number;
}
```

### `data/learning_state.json`

```typescript
interface LearningState {
  decisionCounter: number;          // Total completed decisions
  lastTriggerCount: number;         // Counter saat learning terakhir di-trigger
  isLearning: boolean;              // Flag untuk prevent overlapping runs
}
```

---

## Agent Decision Flow

Dua sesi berjalan paralel dalam main loop:

---

### Sesi 1 — Screening

```
setiap SCAN_INTERVAL_MS:
  1. fetchTrenchesTokens() → ambil token dari gmgn-cli
     - Gunakan GMGN_* env vars untuk filter server-side
  2. filterCandidates() → client-side filter:
     - Skip jika sudah punya posisi terbuka di token ini
     - Skip jika sudah punya posisi di MAX_OPEN_POSITIONS
     - Skip jika token baru saja dijual (SOLD_COOLDOWN_MS)
  3. untuk setiap candidate:
     a. getTokenDetails() → 4 API calls: kline 1m, token traders, token info, token security
        → Hitung: order flow summary, volume deltas, candle patterns, CVD proxy, volume profile
     b. getBuySkipDecision() → AI decision via OpenRouter
     c. recordDecision() → simpan decision record dengan rich context
     d. jika SKIP → update decision outcome, lanjut
     e. jika BUY → executeBuyOrder() → polling confirmation
```

**AI System Prompt (Screening):**
```
You are an elite Solana memecoin trader with 70%+ win rate.
DECISION LOGIC:
- BUY if: strong order flow, smart money accumulation, healthy risk metrics, creator_close
- SKIP if: weak signals, wash trading, creator_hold, distribution detected
- RUG RATIO: High rug ratio (90%+) is WARNING not auto-skip. creator_close = no dump risk.
- NET FLOW: Focus on direction (positive/negative) not absolute amounts for trenches.
```

**User Prompt Sections:**
- PRICE & ORDER FLOW (intensity, net flow, buy/sell ratio)
- SMART MONEY (net flow, buy/sell count, active smart degens, top traders)
- ON-CHAIN FLOW (volume deltas 1m, CVD proxy, candle patterns, volume profile)
- RISK (rug ratio, wash trading, creator status, sniper count, fresh wallet rate, insider hold, token age)
- TOP ENTRY PATTERNS (dari learning system, scored by confidence)
- MISSED OPPORTUNITY WARNINGS (tokens yang di-skip tapi naik)
- FILTER CRITERIA (quality gate patterns)

**Token Quality Gate (client-side rules):**

| Signal | Pass | Watch | Skip |
|--------|------|-------|------|
| `is_wash_trading` | false | — | true → skip immediately |
| `smart_degen_count` | >= 3 | 1-2 | 0 |
| `creator_token_status` | creator_close | — | creator_hold |
| `rug_ratio` | < 0.3 | 0.3-0.7 | > 0.7 |
| `liquidity` | > $50k | $10k-$50k | < $10k |

---

### Sesi 2 — Managing

```
setiap MANAGE_INTERVAL_MS (30 detik):
  1. getPositions() → baca positions.json
  2. untuk setiap posisi:
     a. getTokenDetails() → ambil harga terbaru + market data
     b. updatePositionPnL() → hitung unrealized PnL
     c. getManageDecision() → AI decision via OpenRouter
        → Kirim: position data, market data, learnings, phase (EARLY/ACTIVE/LATE)
     d. recordDecision() → simpan decision record
     e. jika SELL → executeSellOrder() → remove position, polling confirmation
     f. jika HOLD → update position, store decision ID
```

**AI System Prompt (Managing):**
```
DECISION RULES (strict priority):

SELL IMMEDIATELY:
- PnL <= -25% → hard stop loss. No exceptions.
- Rug/wash trading/insider dump detected at ANY PnL.
- Smart money actively distributing at ANY PnL.
- Token age > 30m with negative price trend and declining volume.

SELL IF PROFITABLE + WEAKNESS:
- PnL >= +15% AND any exit signal detected.
- PnL >= +15% AND buy/sell ratio dropping below 1.0.
- Unprofitable for >9 minutes with no recovery signs.

HOLD:
- PnL between -25% and +15% AND no exit signals.
- PnL > +15% AND momentum intact.
- PnL negative BUT showing recovery signs.
```

**Position Phases:**
- EARLY (0-5m): Entry phase, monitor for immediate dump
- ACTIVE (5-15m): Trading phase, track momentum
- LATE (15m+): Mature position, watch for exit signals

**User Prompt Sections:**
- Position info (phase, holding duration, PnL, entry vs current)
- PRICE & ORDER FLOW
- SMART MONEY (current vs entry smart degen count)
- ON-CHAIN FLOW
- RISK
- EXIT PATTERNS (dari learning system)
- HOLD LOSS WARNINGS (patterns yang sering rugi)

---

## Learning System

Event-driven: trigger setiap 30 completed decisions.

**Flow:**
1. `decisionCounter` increment di `updateDecisionOutcome()`
2. Saat counter mencapai kelipatan 30 → fire `learningTriggerCallback`
3. `generateLearnings()`:
   - Ambil 50 decisions terakhir
   - Kirim ke OpenRouter dengan full context (decision type, signals, PnL, context)
   - Parse response → filter patterns (min 50% success rate, min 2 applied count)
   - Simpan ke `learnings.json`
   - Cleanup: keep hanya 200 decisions terakhir, 7 days learning expiry

**Pattern Scoring:**
- `scorePattern()` menghitung weighted composite score:
  - Success rate: 35%
  - PnL: 40%
  - Recency: 25% (linear decay selama 7 hari)
- `getRelevantPatterns()` filter + score patterns berdasarkan decision type
- Patterns di-inject ke AI decision context berikutnya

**Pattern Types:**
- `entry` — When to BUY
- `exit` — When to SELL
- `risk` — When to SKIP
- `filter` — Quality gates
- `timing` — Entry/exit timing
- `volume` — Volume confirmation
- `hold` — When to hold profitably
- `hold_loss` — When holds result in losses
- `missed_opportunity` — Tokens skipped but went up

**Missed Opportunity Analysis:**
- Bandingkan market cap antara consecutive SKIP decisions untuk token yang sama
- >25% gain = missed opportunity
- <-20% change = good skip
- Results di-inject ke AI prompt sebagai warning

---

## Graceful Shutdown

SIGINT/SIGTERM → `gracefulShutdown()`:
1. Guard `isShuttingDown` mencegah double execution
2. Load semua open positions
3. Execute sell untuk setiap posisi (exitReason: "shutdown")
4. DRY RUN: langsung removed + trade logged
5. Live: sell order submitted, background polling

---

## Coding Guidelines

### General
- TypeScript strict mode (`"strict": true`)
- `async/await`, bukan callbacks
- Handle semua errors dengan try/catch — jangan biarkan agent crash
- Log setiap action penting dengan timestamp

### JSON Storage
```typescript
// Read
const data = (await Bun.file("data/trades.json").json()) as Trade[];

// Write (selalu overwrite dengan array lengkap)
await Bun.write("data/trades.json", JSON.stringify(data, null, 2));
```
- Selalu buat file JSON kosong `[]` atau `{}` jika belum ada
- Gunakan mutex locking di `db.ts` untuk concurrent access safety

### Error Handling
- GMGN API gagal → log error, skip token, lanjut
- OpenRouter gagal → gunakan fallback rule-based decision
- Trade gagal → catat di trades.json dengan status "failed"
- Order pending > 60 detik → mark "expired"
- Order confirmed → buat position otomatis via polling

---

## Perintah Bun

```bash
# Install dependencies
bun install

# Jalankan agent
bun run src/index.ts

# Development (watch mode)
bun run dev

# Dry run (simulasi)
bun run dry-run

# Build untuk production
bun run build

# Lihat performa
bun run stats

# Jalankan tests
bun test
```

---

## Referensi

- OpenRouter Docs: https://openrouter.ai/docs
- Bun Docs: https://bun.sh/docs
- gmgn-cli: via `gmgn-cli --help`

---

## Peringatan

> RISIKO TINGGI: Token trenches sangat volatile. Selalu mulai dengan `DRY_RUN=true`.
>
> KEAMANAN: Jangan pernah commit `.env` atau private key ke git.
>
> DANA: Mulai dengan AMOUNT_SOL kecil ($5-$10 per posisi) sampai agent terbukti stabil.
