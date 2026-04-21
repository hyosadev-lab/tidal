# CLAUDE.md — Trenches Trading Agent

Dokumen ini adalah panduan utama untuk AI coding agent (openclaude) dalam membangun dan memaintain **Trenches Trading Agent** — sistem trading otomatis 24/7 berbasis Bun + TypeScript yang menggunakan GMGN API untuk market data & eksekusi, serta OpenRouter sebagai decision engine.

---

## Ringkasan Proyek

Trading agent yang berjalan terus-menerus, memantau token-token di "Trenches" (market cap $10K–$1M+), membuat keputusan buy/sell berbasis AI, dan belajar dari setiap trade yang dilakukan melalui feedback loop berbasis file JSON.

**Stack:**
- **Runtime**: Bun (bukan Node.js)
- **Bahasa**: TypeScript strict mode
- **Data Storage**: File JSON lokal (`data/` directory)
- **Market Data & Eksekusi**: `gmgn-cli` (sudah terinstall)
- **AI Decision Engine**: OpenRouter API (OpenAI-compatible)
- **Target**: Token Trenches Solana (pump.fun, letsbonk, dll) — market cap $10K–$1M+

---

## Struktur Direktori

```
trading-agent/
├── CLAUDE.md                  # File ini
├── .env                       # API keys & config (JANGAN di-commit)
├── .env.example               # Template env vars
├── .gitignore
├── package.json               # Bun project
├── tsconfig.json
├── src/
│   ├── index.ts               # Entry point — jalankan kedua sesi paralel
│   ├── agent/
│   │   ├── decision.ts        # AI Screening: BUY/SKIP decision
│   │   ├── manager.ts         # AI Managing: HOLD/SELL decision
│   │   └── learner.ts         # Learning dari trade history
│   ├── sessions/
│   │   ├── screening.ts       # Screening session loop
│   │   └── managing.ts        # Managing session loop
│   ├── gmgn/
│   │   ├── client.ts          # Wrapper gmgn-cli calls
│   │   ├── trenches.ts        # Fetch trenches tokens
│   │   ├── market.ts          # Market data (kline, rank, traders)
│   │   └── trade.ts           # Execute swap, query order
│   ├── storage/
│   │   ├── db.ts              # JSON file read/write helpers
│   │   └── types.ts           # Semua TypeScript interfaces/types
│   └── utils/
│       ├── concurrency.ts     # Manage async function
│       ├── logger.ts          # Structured logging
│       └── helpers.ts         # Auth utils, UUID, dll
└── data/
    ├── trades.json            # History semua trades
    ├── positions.json         # Open positions saat ini
    ├── watchlist.json         # Token yang sedang dipantau
    ├── performance.json       # Metrics performa agent
    └── learnings.json         # Pattern & insight dari trades lalu
```

---

## Environment Variables (.env)

```env
# GMGN API
GMGN_API_KEY=your_gmgn_api_key
GMGN_PRIVATE_KEY=your_private_key_for_trade_signing   # Ed25519 atau RSA
GMGN_WALLET_ADDRESS=your_wallet_address
GMGN_CHAIN=sol

# OpenRouter
OPENROUTER_API_KEY=your_openrouter_api_key
OPENROUTER_MODEL=openrouter/elephant-alpha            # atau model lain yang cepat & murah

# Trading Config
MAX_OPEN_POSITIONS=5               # Maks posisi terbuka sekaligus
TAKE_PROFIT_PERCENT=50             # Take profit di +50%
STOP_LOSS_PERCENT=30               # Stop loss di -30%
SCAN_INTERVAL_MINUTES=0.5          # Screening: scan trenches setiap 0.5 menit (30 detik)
MANAGE_INTERVAL_MINUTES=0.1667     # Managing: monitor posisi terbuka setiap 0.1667 menit (10 detik)
SLIPPAGE=0.15                      # 15% slippage untuk trenches

# Agent
DRY_RUN=true                       # true = simulasi, false = live trading
LOG_LEVEL=info
```

---

## GMGN CLI — Cara Penggunaan

`gmgn-cli` adalah tool utama untuk semua interaksi dengan GMGN API. Semua calls dilakukan melalui CLI subprocess, bukan langsung HTTP.

### Endpoints yang Digunakan

**1. Trenches — scan token baru**
```
gmgn-cli market trenches --chain sol --type completed --filter-preset safe --min-smart-degen-count 1 --raw
```
Response: `data.new_creation[]`, `data.pump[]`, `data.completed[]`

**2. K-line data (candlestick)**
```
gmgn-cli market kline --chain sol --address <token_address> --resolution 1m --from <timestamp> --to <timestamp> --raw
```
- Resolution `1m`: 30 candles (30 menit terakhir)
- Resolution `5m`: 12 candles (60 menit terakhir)

**3. Token Top Traders (Smart Money)**
```
gmgn-cli token traders --chain sol --address <token_address> --tag smart_degen --limit 10 --raw
```

**4. Token Info** - Get basic token data
```
gmgn-cli token info --chain sol --address <token_address> --raw
```
Response includes: price, liquidity, holder_count, wallet_tags_stat, launchpad_platform, stat, dev

**5. Token Security** - Get security metrics
```
gmgn-cli token security --chain sol --address <token_address> --raw
```
Response includes: rug_ratio, is_wash_trading, creator_token_status, bundler_trader_amount_rate, renounced_mint, etc.

**6. Execute Swap (BUY/SELL)**
```
gmgn-cli swap --chain sol --from <wallet_address> --input-token <input_token> --output-token <output_token> --amount <amount> --slippage <slippage>
```
- Buy: input-token = SOL address (`So11111111111111111111111111111111111111112`), output-token = token address
- Sell: input-token = token address, output-token = SOL address, use --percent 100 untuk jual semua

**7. Query Order Status**
```
gmgn-cli order get --chain sol --order-id <order_id> --raw
```
Status: `pending` → `processed` → `confirmed` | `failed` | `expired`

---

## Data Storage Schema (JSON)

### `data/trades.json`
```typescript
interface Trade {
  id: string;                    // UUID
  tokenAddress: string;
  tokenSymbol: string;
  tokenName: string;
  action: "BUY" | "SELL";
  inputAmount: string;           // amount dalam minimum unit
  inputAmountUsd: number;
  outputAmount: string;
  priceAtTrade: number;
  marketCapAtTrade: number;
  timestamp: number;             // Unix ms
  orderId: string;
  orderStatus: "pending" | "confirmed" | "failed" | "expired";
  txHash?: string;
  isDryRun: boolean;

  // Diisi saat SELL
  entryPrice?: number;
  exitPrice?: number;
  pnlUsd?: number;
  pnlPercent?: number;
  holdingDurationMs?: number;
  exitReason?: "take_profit" | "stop_loss" | "ai_decision" | "manual";

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
  amountToken: string;           // jumlah token yang dipegang
  costUsd: number;               // total biaya dalam USD
  currentPrice?: number;         // update periodik
  currentMarketCap?: number;
  unrealizedPnlUsd?: number;
  unrealizedPnlPercent?: number;
  lastUpdated: number;
  buyTradeId: string;
  // Data saat entry untuk perbandingan
  smartDegenEntryCount?: number; // jumlah smart degen saat entry
}
```

### `data/learnings.json`
```typescript
interface Learning {
  id: string;
  createdAt: number;
  basedOnTradeIds: string[];
  insight: string;               // AI-generated insight
  pattern: {
    type: "entry" | "exit" | "filter" | "risk";
    description: string;
    successRate?: number;
    avgPnlPercent?: number;
  };
  appliedCount: number;          // berapa kali pattern ini dipakai
  successCount: number;          // berapa kali berhasil
}
```

### `data/performance.json`
```typescript
interface Performance {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalPnlUsd: number;
  avgWinPercent: number;
  avgLossPercent: number;
  largestWinUsd: number;
  largestLossUsd: number;
  avgHoldingHours: number;
  lastUpdated: number;
  dailyStats: Record<string, {   // key: "YYYY-MM-DD"
    pnl: number;
    trades: number;
    wins: number;
  }>;
}
```

---

## Agent Decision Flow

Terdapat dua sesi yang berjalan bersamaan dalam main loop:

---

### Sesi 1 — Screening

Bertugas mencari token baru dan memutuskan **SKIP** atau **BUY**.

```
setiap SCAN_INTERVAL_MS:
  1. fetchTrenches() → ambil token yang sudah 'completed' menggunakan gmgn-cli
     Gunakan server-side filters langsung di CLI:
       --filter-preset safe
       --min-smart-degen-count 1
       --min-marketcap 20000
       --max-marketcap 2000000
       --max-rug-ratio 0.3
       --max-bundler-rate 0.3
       --max-insider-ratio 0.3
       --sort-by smart_degen_count
  2. filterCandidates() → filter client-side tambahan setelah hasil CLI:
     - Tolak jika sudah punya posisi terbuka di token ini
     - Tolak jika posisi terbuka >= MAX_OPEN_POSITIONS
  3. untuk setiap candidate:
     a. fetchTokenDetails() → kline 1m (30 candle), kline 5m (12 candle), top_traders smart_degen
     b. aiDecision() → kirim context ke OpenRouter
     c. jika SKIP → log dan lanjut
     d. jika BUY → executeBuy() → simpan pending trade → start polling confirmation

**Order Confirmation Flow:**
- DRY RUN: Langsung confirmed → buat trade & position
- Real Order: Pending → polling setiap 3 detik (max 60 detik) → confirmed → buat position
- Jika order gagal/timeout → status diupdate, position tidak dibuat
```

**AI Context for Screening (BUY/SKIP):**

System prompt:
```
You are an expert crypto trader specializing in Solana memecoins "Trenches" — tokens with market cap $20K–$2M.
Your task is to analyze token data and decide whether to BUY or SKIP.
Answer ONLY in JSON format: { "action": "BUY"|"SKIP", "confidence": 0-100, "reasoning": "...", "signals": ["signal1", ...] }
```

User message:
```
TOKEN: {symbol} ({address})
Market Cap: ${usdMarketCap}
Liquidity: ${liquidity}
Volume 1h: ${volume1h} | Volume 24h: ${volume24h}
Swaps 1h: {swaps1h} | Swaps 24h: {swaps24h}
Buys 24h: {buys24h} | Sells 24h: {sells24h}
Price Change 1h: {change1h}%
Holder Count: {holderCount}
Smart Degen Count: {smartDegenCount}
Renowned Count: {renownedCount}
Top 10 Holder Rate: {top10HolderRate}
Creator Status: {creatorTokenStatus} | Creator Balance Rate: {creatorBalanceRate}
Rug Ratio: {rugRatio} | Bundler Rate: {bundlerRate} | Insider Ratio: {insiderRatio}
Is Wash Trading: {isWashTrading}
Launchpad: {launchpadPlatform}
Renounced Mint: {renouncedMint} | Renounced Freeze: {renouncedFreezeAccount}
Has Social: {hasAtLeastOneSocial}
CTO Flag: {ctoFlag}

K-line 1m last (30 candles):
{kline1mData}

K-line 5m last (12 candles):
{kline5mData}

Top Smart Degen Traders (holding/activity):
{topTradersSummary}

RELEVANT LEARNINGS from previous trades:
{relevantLearnings}
```

**Token Quality Gate (referensi dari GMGN SKILL.md):**

| Signal | 🟢 Pass | 🟡 Watch | 🔴 Skip |
|--------|---------|---------|---------|
| `smart_degen_count` | ≥ 3 | 1–2 | 0 |
| `rug_ratio` | < 0.1 | 0.1–0.3 | > 0.3 |
| `creator_token_status` | `creator_close` | — | `creator_hold` |
| `is_wash_trading` | `false` | — | `true` → skip immediately |
| `top_10_holder_rate` | < 0.20 | 0.20–0.50 | > 0.50 |
| `liquidity` | > $50k | $10k–$50k | < $10k |

Quick disqualification: jika `rug_ratio > 0.3` OR `is_wash_trading = true` → skip tanpa analisis lebih lanjut.

---

### Sesi 2 — Managing

Bertugas memantau posisi yang sudah dibeli dan memutuskan **HOLD** atau **SELL**.

```
setiap MANAGE_INTERVAL_MS (lebih sering dari Screening, misal 10 detik):
  1. syncPositionsFromTrades() → sync position dari confirmed trades yang belum ada di positions.json
  2. loadOpenPositions() → baca positions.json
  3. untuk setiap posisi:
     a. fetchCurrentPrice() → ambil harga terbaru via kline 1m
     b. updatePositionPnL() → hitung unrealized PnL
     c. checkHardRules():
        - jika unrealizedPnlPercent >= TAKE_PROFIT_PERCENT → executeSell("take_profit")
        - jika unrealizedPnlPercent <= -STOP_LOSS_PERCENT → executeSell("stop_loss")
     d. jika tidak trigger hard rules → aiManageDecision()
        - kirim context posisi + market data ke OpenRouter
        - jika SELL → executeSell("ai_decision")
        - jika HOLD → update lastUpdated, lanjut
  4. learnFromRecentTrades() → setiap 5 trade confirmed, generate insight baru
```

**AI Context for Managing (HOLD/SELL):**

System prompt:
```
You are an expert crypto trader specializing in Solana memecoins "Trenches".
Your task is to evaluate open positions and decide whether to HOLD or SELL.
Answer ONLY in JSON format: { "action": "HOLD"|"SELL", "confidence": 0-100, "reasoning": "...", "signals": ["signal1", ...] }
```

User message:
```
POSITION: {symbol} ({address})
Entry Price: ${entryPrice} | Entry Market Cap: ${entryMarketCap}
Current Price: ${currentPrice} | Current Market Cap: ${currentMarketCap}
Unrealized PnL: {unrealizedPnlPercent}% (${unrealizedPnlUsd})
Holding Duration: {holdingDurationHuman}
Cost: ${costUsd}

Market Data Latest:
Price Change 1h: {priceChange1h}%
Smart Degen Count: {smartDegenCount} (at entry: {smartDegenEntryCount})
Holder Count: {holderCount}
Rug Ratio: {rugRatio}
Creator Status: {creatorTokenStatus}
Is Wash Trading: {isWashTrading}
Liquidity: ${liquidity}

K-line 1m last (30 candles):
{kline1mData}

K-line 5m last (12 candles):
{kline5mData}

Take Profit target: +{TAKE_PROFIT_PERCENT}%
Stop Loss target: -{STOP_LOSS_PERCENT}%

RELEVANT LEARNINGS from previous trades:
{relevantLearnings}
```

---

## Learning System

Setiap kali 5 trade baru selesai (status confirmed), panggil `generateLearnings()`:

1. Ambil 20 trade terakhir dari `trades.json`
2. Kirim ke OpenRouter dengan prompt berisi:
   - Statistik: total trades, win rate, avg PnL
   - Detail setiap trade: token, entry/exit price, PnL, holding duration, reasoning
   - Permintaan analisis pattern entry/exit/risk/filter
3. Parse response JSON dan simpan ke `learnings.json`
4. Inject learnings yang relevan ke AI decision context berikutnya

**Fallback:** Jika OpenRouter gagal, generate insight berdasarkan statistik aktual:
- Win rate tinggi (>60%) → "Current strategy is working, continue current approach"
- Win rate rendah (<40%) → "Current strategy needs adjustment, review entry/exit criteria"
- Holding duration terlalu lama (>24h) → "Consider shorter holds for faster capital rotation"
- Holding duration terlalu pendek (<1h) → "Ensure not selling too early on small moves"

**Format Learning:**
```typescript
interface Learning {
  id: string;
  createdAt: number;
  basedOnTradeIds: string[];
  insight: string;               // AI-generated insight
  pattern: {
    type: "entry" | "exit" | "filter" | "risk";
    description: string;
    successRate?: number;
    avgPnlPercent?: number;
  };
  appliedCount: number;          // berapa kali pattern ini dipakai
  successCount: number;          // berapa kali berhasil
}
```

---

## Cara Menjalankan gmgn-cli

```typescript
import { $ } from "bun";

// Contoh call trenches
async function fetchTrenches(chain: string) {
  const timestamp = Math.floor(Date.now() / 1000);
  const clientId = crypto.randomUUID();

  const result = await $`gmgn-cli trenches --chain ${chain} --timestamp ${timestamp} --client-id ${clientId}`.json();
  return result.data;
}

// Contoh execute swap
async function executeSwap(params: SwapParams) {
  const timestamp = Math.floor(Date.now() / 1000);
  const clientId = crypto.randomUUID();

  // Untuk trade, butuh signature — generate dulu
  const signature = await generateSignature(params, timestamp, clientId);

  const result = await $`gmgn-cli swap \
    --chain ${params.chain} \
    --from ${params.fromAddress} \
    --input-token ${params.inputToken} \
    --output-token ${params.outputToken} \
    --input-amount ${params.inputAmount} \
    --slippage ${params.slippage} \
    --timestamp ${timestamp} \
    --client-id ${clientId} \
    --signature ${signature}`.json();

  return result.data;
}
```

> **Catatan**: Sesuaikan exact CLI syntax dengan output `gmgn-cli --help`. Wrapper di `src/gmgn/client.ts` harus handle error dan retry logic.

---

## OpenRouter Integration

```typescript
// src/agent/decision.ts
const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
    "HTTP-Referer": "https://github.com/trading-agent",
    "X-Title": "Trenches Trading Agent"
  },
  body: JSON.stringify({
    model: process.env.OPENROUTER_MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserPrompt(tokenData, learnings) }
    ],
    response_format: { type: "json_object" },
    temperature: 0.3,    // rendah untuk konsistensi
    max_tokens: 500
  })
});

const data = await response.json();
const decision = JSON.parse(data.choices[0].message.content);
// decision: { action, confidence, reasoning, signals }
```

**Fallback Decision (jika OpenRouter gagal atau tidak dikonfigurasi):**

```typescript
// Rule-based fallback using available data
1. Rug Ratio > 0.3 → SELL (high risk)
2. Wash Trading detected → SELL (suspicious activity)
3. Creator still holding → HOLD (watch for sell pressure)
4. Liquidity < $10,000 → SELL (low liquidity)
5. Default → HOLD with low confidence
```

---

## Coding Guidelines

### General
- Semua file TypeScript dengan strict mode (`"strict": true` di tsconfig)
- Gunakan `async/await`, bukan callbacks atau raw `.then()`
- Handle semua errors dengan try/catch — jangan biarkan agent crash
- Log setiap action penting dengan timestamp
- Gunakan `Bun.file()` untuk file I/O, bukan `fs`

### JSON Storage
```typescript
// Read
const data = await Bun.file("data/trades.json").json() as Trade[];

// Write (selalu overwrite dengan array lengkap)
await Bun.write("data/trades.json", JSON.stringify(data, null, 2));
```

Selalu buat file JSON kosong `[]` atau `{}` jika belum ada (first run).

### Error Handling
- Jika GMGN API gagal → log error, skip token, lanjut ke berikutnya. Jangan stop loop.
- Jika OpenRouter gagal → gunakan fallback rule-based decision (SKIP jika tidak yakin)
- Jika trade gagal → catat di trades.json dengan status "failed", jangan retry otomatis
- Jika order pending > 60 detik → mark sebagai "expired" (polling timeout)
- Jika order confirmed → buat position otomatis via polling function
- Sync positions dari trades setiap monitoring loop untuk backward compatibility

### Order Confirmation Flow

**DRY RUN Mode:**
- Simulasikan semua trades tanpa eksekusi nyata
- Order langsung "confirmed" → buat trade & position segera
- Catat di trades.json dengan `isDryRun: true`

**Real Order Mode:**
1. Execute buy → dapatkan `order_id` dari GMGN
2. Simpan trade dengan status "pending"
3. Start polling function (background):
   - Cek order status setiap 3 detik
   - Timeout setelah 60 detik
   - Jika "confirmed": update trade status, buat position, save ke positions.json
   - Jika "failed" atau "expired": update trade status, tidak buat position

**Backward Compatibility:**
- `syncPositionsFromTrades()` mencari confirmed BUY trades tanpa position
- Buat position dari trade data (untuk trades lama sebelum polling diimplementasikan)

---

## Perintah Bun

```bash
# Install dependencies
bun install

# Jalankan agent
bun run src/index.ts

# Jalankan dengan watch mode (development)
bun --watch run src/index.ts

# Jalankan dengan dry run
DRY_RUN=true bun run src/index.ts

# Build untuk production
bun build src/index.ts --outfile dist/agent.js --target bun
```

---

## package.json Scripts

```json
{
  "scripts": {
    "start": "bun run src/index.ts",
    "dev": "bun --watch run src/index.ts",
    "dry-run": "DRY_RUN=true bun run src/index.ts",
    "build": "bun build src/index.ts --outfile dist/agent.js --target bun",
    "stats": "bun run src/utils/stats.ts"
  }
}
```

---

## Urutan Implementasi (untuk AI Agent)

Implementasi dalam urutan ini, satu per satu:

1. **Setup project** — `package.json`, `tsconfig.json`, `.env.example`, `.gitignore`
2. **Types** — `src/storage/types.ts` — semua interfaces
3. **Storage helpers** — `src/storage/db.ts` — read/write JSON
4. **Logger** — `src/utils/logger.ts`
5. **GMGN client** — `src/gmgn/client.ts` — wrapper gmgn-cli subprocess
6. **Trenches fetcher** — `src/gmgn/trenches.ts`
7. **Market data** — `src/gmgn/market.ts`
8. **Trade executor** — `src/gmgn/trade.ts`
9. **AI Decision — Screening** — `src/agent/decision.ts` → logika BUY/SKIP
10. **AI Decision — Managing** — `src/agent/manager.ts` → logika HOLD/SELL
11. **Learning system** — `src/agent/learner.ts`
12. **Screening session** — `src/sessions/screening.ts` → loop scan + filter + buy
13. **Managing session** — `src/sessions/managing.ts` → loop monitor + TP/SL + sell
14. **Main loop** — `src/index.ts` → jalankan kedua sesi secara paralel

---

## Referensi

- OpenRouter Docs: https://openrouter.ai/docs
- Bun Docs: https://bun.sh/docs

---

## Peringatan Penting

> ⚠️ **RISIKO TINGGI**: Token trenches sangat volatile. Selalu mulai dengan `DRY_RUN=true` dan test strategi minimal 100 trade simulasi sebelum live.
>
> ⚠️ **KEAMANAN**: Jangan pernah commit `.env` atau file yang berisi private key ke git. Pastikan `.gitignore` mencakup `.env` dan `data/`.
>
> ⚠️ **DANA**: Set `MAX_POSITION_USD` ke nilai kecil saat pertama kali live (misal $5–$10 per posisi) sampai agent terbukti stabil.
