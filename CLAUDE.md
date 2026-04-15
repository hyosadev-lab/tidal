# CLAUDE.md — GMGN AI Trading Bot

## 🎯 Project Overview

We are building an **autonomous AI trading bot for Solana** that:
- Fetches real-time market data from the **GMGN API**
- Makes buy/sell/hold decisions using **Claude AI (Anthropic API)**
- Learns from past trading history stored in **JSON files**
- Runs **24/7 autonomously** with no human intervention required
- Currently in **Phase 1: Data Collection** (no live trading yet)

---

## 🗺️ Development Phases

| Phase | Status | Description |
|-------|--------|-------------|
| **Phase 1** | ✅ In Progress | Data collection — pull & store market data from GMGN API |
| **Phase 2** | 🔜 Next | Decision Engine — Claude AI analyzes data, paper trading |
| **Phase 3** | 🔜 Later | Live trading with small capital |
| **Phase 4** | 🔜 Later | Learning loop — AI improves from trade history |

**We are currently working on Phase 1.**

---

## 🛠️ Tech Stack

| Layer | Technology |
|-------|-----------|
| Language | **TypeScript** (strict mode) |
| Runtime | Node.js |
| Data Storage | **JSON files** (no database) |
| Market Data + Trade Execution | **GMGN API** (`https://gmgn.ai/api/v1`) |
| AI Decision Engine | **Anthropic Claude API** (claude-sonnet-4-20250514) |
| Scheduler | `setInterval` (built-in, no extra lib) |
| Target Chain | **Solana (SOL)** |

---

## 📁 Project Structure

```
gmgn-trading-bot/
├── src/
│   ├── types.ts              ← All TypeScript interfaces & types
│   ├── index.ts              ← Entry point + 24/7 scheduler
│   ├── data/
│   │   ├── gmgn.ts           ← GMGN API client (fetch market data)
│   │   └── collector.ts      ← Orchestrates data collection cycles
│   └── storage/
│       └── db.ts             ← All JSON read/write operations
├── data/
│   └── db.json               ← Main data store (auto-generated, gitignored)
├── .env                      ← API keys (never commit this)
├── .env.example              ← Template for .env
├── .gitignore
├── package.json
├── tsconfig.json
└── CLAUDE.md                 ← This file
```

---

## 🔑 Environment Variables

```bash
# Required for Phase 1 (data collection)
GMGN_API_KEY=your_gmgn_api_key_here

# Required for Phase 3+ (live trading)
GMGN_PRIVATE_KEY=your_private_key_here

# Required for Phase 2+ (AI decisions)
ANTHROPIC_API_KEY=your_anthropic_api_key_here
```

Get API keys:
- GMGN: https://gmgn.ai/ai (upload public key → get API key)
- Anthropic: https://console.anthropic.com

---

## 📐 Core Data Types

All types are defined in `src/types.ts`. Key types:

```typescript
TokenInfo         // Token price, volume, liquidity, marketCap
CandlestickData   // OHLCV candles for a token (multiple resolutions)
TrendingToken     // Trending token with rank and price changes
ContractSecurity  // Honeypot check, risk level, holder distribution
TradeLog          // Every decision made: BUY/SELL/HOLD + result
StorageSchema     // Root shape of data/db.json
```

---

## 💾 Storage Convention

All data lives in `data/db.json` with this shape:

```json
{
  "tokens": { "<address>": TokenInfo },
  "candlesticks": { "<address>_<resolution>": CandlestickData },
  "trending": [ TrendingToken ],
  "security": { "<address>": ContractSecurity },
  "tradeLogs": [ TradeLog ],
  "lastUpdated": "ISO timestamp"
}
```

Storage functions are in `src/storage/db.ts`. Always use these functions — never read/write `db.json` directly from other files.

---

## 🌐 GMGN API Convention

Base URL: `https://gmgn.ai/api/v1`  
Chain: `sol` (Solana)  
Auth: `Authorization: Bearer <GMGN_API_KEY>`

Key endpoints used:
```
GET /token/sol/:address              → Token info & price
GET /token/sol/:address/candlestick  → OHLCV candles
GET /token/sol/trending              → Trending tokens list
GET /token/sol/:address/security     → Contract security check
GET /wallet/sol/:address/portfolio   → Wallet holdings
POST /swap                           → Execute trade (Phase 3+)
```

All API calls go through `src/data/gmgn.ts`. Never call the GMGN API directly from other files.

---

## 🧠 AI Decision Engine (Phase 2 — Not Built Yet)

When we reach Phase 2, the decision engine will:
1. Read recent candlestick data + security check from `db.json`
2. Read last 20 trade logs as "memory" (learning from history)
3. Send all context to Claude API with a structured prompt
4. Parse Claude's response: `BUY | SELL | HOLD | SKIP`
5. Log the decision to `tradeLogs` in `db.json`
6. (Phase 3) Execute swap via GMGN API if BUY/SELL

The AI learns by receiving its own past trade logs as context in every prompt — it can observe patterns like "last 3 times I bought at high RSI, the token dumped."

---

## 🛡️ Risk Management Rules (Phase 3 — Not Built Yet)

These are hard rules that **cannot be overridden by AI**:
- Skip tokens with `riskLevel === "HIGH"` (honeypot, etc.)
- Skip tokens with `top10HolderPercent > 80%`
- Max buy size: 0.1 SOL per trade
- Max daily loss: 0.5 SOL
- Never trade tokens with liquidity < $10,000

---

## ⚙️ Running the Project

```bash
# Install dependencies
npm install

# Setup environment
cp .env.example .env
# → Fill in GMGN_API_KEY in .env

# Run in development
npm start
# or
npm run dev
```

The bot runs a collection cycle immediately, then repeats every **5 minutes**.  
Stop with `Ctrl+C` — it will print final stats before exiting.

---

## 📏 Coding Conventions

- **TypeScript strict mode** — no `any` unless absolutely necessary
- **No external libraries** unless really needed (keep dependencies minimal)
- All async functions use `async/await` (no raw `.then()` chains)
- Add `delay()` between API calls to avoid rate limiting
- Every file has a comment block at the top explaining its purpose
- Console logs use emoji prefixes: ✅ success, ❌ error, 📡 fetch, 🔥 trending, etc.
- Never hardcode API keys — always use `process.env`

---

## 🚫 What NOT To Do

- Do NOT add `dotenv` library — we load `.env` manually in `src/index.ts`
- Do NOT write directly to `data/db.json` — always use functions in `src/storage/db.ts`
- Do NOT call GMGN API outside of `src/data/gmgn.ts`
- Do NOT execute live trades until Phase 3 is explicitly started
- Do NOT commit `.env` or `data/db.json` to git
- Do NOT use `any` type without a comment explaining why

---

## 📝 Current TODO (Phase 1 Completion)

- [ ] Verify GMGN API endpoint paths match actual API documentation
- [ ] Add retry logic for failed API calls in `src/data/gmgn.ts`
- [ ] Add watchlist token addresses in `src/index.ts` (`WATCHLIST` array)
- [ ] Test full collection cycle with real GMGN API key
- [ ] Begin Phase 2: Build `src/ai/decision.ts` (Claude decision engine)

---

## 🔗 Key References

- GMGN API Docs: https://docs.gmgn.ai/index/gmgn-agent-api
- Anthropic API Docs: https://docs.anthropic.com
- OpenClaude: https://github.com/Gitlawb/openclaude
