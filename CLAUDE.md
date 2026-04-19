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
OPENROUTER_MODEL=anthropic/claude-3.5-haiku            # atau model lain yang cepat & murah

# Trading Config
MAX_OPEN_POSITIONS=5               # Maks posisi terbuka sekaligus
TAKE_PROFIT_PERCENT=50             # Take profit di +50%
STOP_LOSS_PERCENT=30               # Stop loss di -30%
SCAN_INTERVAL_MS=30000             # Screening: scan trenches setiap 30 detik
MANAGE_INTERVAL_MS=10000           # Managing: monitor posisi terbuka setiap 10 detik
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
GET /v1/trenches?chain=sol&limit=50
```
Response: `data.new_creation[]`, `data.pump[]`, `data.completed[]`

Setiap item adalah `RankItem` — sama struktur dengan `/v1/market/rank`.

**2. Market Rank — trending tokens**
```
GET /v1/market/rank?chain=sol&interval=5m&limit=20&order_by=swaps&filters=renounced&filters=frozen
```

**3. K-line data**
```
GET /v1/market/token_kline?chain=sol&address=TOKEN_ADDRESS&resolution=1m
```

**4. Top Traders**
```
GET /v1/market/token_top_traders?chain=sol&address=TOKEN_ADDRESS&tag=smart_degen&limit=10
```

**5. Execute Swap (BUY)**
```
POST /v1/trade/swap
Body: { chain, from_address, input_token, output_token, input_amount, slippage, auto_slippage, is_anti_mev: true }
```
- Beli token: `input_token` = SOL address (`So11111111111111111111111111111111111111112`), `output_token` = token address
- Jual token: `input_token` = token address, `output_token` = SOL address, gunakan `input_amount_bps: "10000"` untuk jual semua

**6. Query Order Status**
```
GET /v1/trade/query_order?order_id=ORDER_ID&chain=sol
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
  1. fetchTrenches() → ambil token dari pump/migrated menggunakan gmgn-cli
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
     a. fetchTokenDetails() → kline 1m (5 candle terakhir), top_traders smart_degen
     b. aiDecision() → kirim context ke OpenRouter
     c. jika SKIP → log dan lanjut
     d. jika BUY → executeBuy() → simpan ke positions.json + trades.json
```

**AI Context untuk Screening (BUY/SKIP):**

System prompt:
```
Kamu adalah expert crypto trader yang spesialis di Solana memecoin "Trenches" — token baru dengan market cap $20K–$2M.
Tugasmu menganalisis data token dan memutuskan apakah harus BUY atau SKIP.
Jawab HANYA dalam format JSON: { "action": "BUY"|"SKIP", "confidence": 0-100, "reasoning": "...", "signals": ["signal1", ...] }
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

K-line 1m terakhir (5 candle):
{klineData}

Top Smart Degen Traders (holding/activity):
{topTradersSummary}

LEARNINGS dari trade sebelumnya yang relevan:
{relevantLearnings}

POSISI TERBUKA saat ini: {openPositionsCount}/{MAX_OPEN_POSITIONS}
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
  1. loadOpenPositions() → baca positions.json
  2. untuk setiap posisi:
     a. fetchCurrentPrice() → ambil harga terbaru via kline 1m
     b. updatePositionPnL() → hitung unrealized PnL
     c. checkHardRules():
        - jika unrealizedPnlPercent >= TAKE_PROFIT_PERCENT → executeSell("take_profit")
        - jika unrealizedPnlPercent <= -STOP_LOSS_PERCENT → executeSell("stop_loss")
     d. jika tidak trigger hard rules → aiManageDecision()
        - kirim context posisi + market data ke OpenRouter
        - jika SELL → executeSell("ai_decision")
        - jika HOLD → update lastUpdated, lanjut
  3. learnFromRecentTrades() → setiap 5 trade confirmed, generate insight baru
```

**AI Context untuk Managing (HOLD/SELL):**

System prompt:
```
Kamu adalah expert crypto trader yang spesialis di Solana memecoin "Trenches".
Tugasmu mengevaluasi posisi yang sedang dipegang dan memutuskan apakah harus HOLD atau SELL.
Jawab HANYA dalam format JSON: { "action": "HOLD"|"SELL", "confidence": 0-100, "reasoning": "...", "signals": ["signal1", ...] }
```

User message:
```
POSISI: {symbol} ({address})
Entry Price: ${entryPrice} | Entry Market Cap: ${entryMarketCap}
Current Price: ${currentPrice} | Current Market Cap: ${currentMarketCap}
Unrealized PnL: {unrealizedPnlPercent}% (${unrealizedPnlUsd})
Holding Duration: {holdingDurationHuman}
Cost: ${costUsd}

Market Data Terkini:
Volume 1h: ${volume1h} | Swaps 1h: {swaps1h}
Smart Degen Count: {smartDegenCount} (saat entry: {smartDegenCountAtEntry})
Holder Count: {holderCount}
Rug Ratio: {rugRatio}
Creator Status: {creatorTokenStatus}
Is Wash Trading: {isWashTrading}

K-line 1m terakhir (5 candle):
{klineData}

Take Profit target: +{TAKE_PROFIT_PERCENT}%
Stop Loss target: -{STOP_LOSS_PERCENT}%

LEARNINGS dari trade sebelumnya yang relevan:
{relevantLearnings}
```

---

## Learning System

Setiap kali 5 trade baru selesai (status confirmed), panggil `generateLearnings()`:

1. Ambil 20 trade terakhir dari `trades.json`
2. Kirim ke OpenRouter dengan prompt:
   ```
   Analisis trade history ini dan identifikasi pattern yang berhasil dan gagal.
   Buat 2-3 insight spesifik yang bisa meningkatkan win rate.
   Format JSON array: [{ type, description, successRate, avgPnlPercent }]
   ```
3. Simpan insights ke `learnings.json`
4. Inject learnings yang relevan ke AI decision context berikutnya

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
- Jika order stuck di "pending" > 60 detik → mark sebagai "expired"

### Dry Run Mode
Jika `DRY_RUN=true`:
- Simulasikan semua trades tanpa eksekusi nyata
- Catat di trades.json dengan `isDryRun: true`
- Update positions.json seperti biasa
- Berguna untuk testing strategi sebelum live

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
