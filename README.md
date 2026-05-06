# Tidal

Autonomous Solana memecoin trading agent for the "Trenches" ($20K-$2M market cap tokens).

**Beta 0.1** — Simulation mode

---

## Features

- **Dual-session architecture** — screening (token discovery) + managing (position monitoring) run in parallel
- **AI-powered decisions** — BUY/SKIP screening and HOLD/SELL management via Gemini 2.5 Flash Lite
- **Event-driven learning** — analyzes every 30 decisions to extract actionable trading patterns
- **On-chain flow analysis** — volume deltas, CVD proxy, candlestick patterns, volume profiles
- **Smart money tracking** — degen count, renowned traders, order flow intensity
- **Missed opportunity detection** — tracks tokens that were skipped but went up
- **Decision recording** — rich context capture for continuous learning improvement
- **Graceful shutdown** — auto-closes all positions on SIGINT/SIGTERM
- **Dry-run mode** — simulate all trades without real execution


---

## Prerequisites

- [Bun](https://bun.sh) 1.3+
- [gmgn-cli](https://www.npmjs.com/package/gmgn-cli) — `bun install -g gmgn-cli`
- GMGN API key + wallet (for market data and trade execution)
- OpenRouter API key (for AI decisions)

---

## Quick Start

```bash
# Clone
git clone <repo-url>
cd tidal

# Install
bun install

# Configure
cp .env.example .env
# Edit .env — fill in your API keys

# Run in simulation mode
bun run dry-run

# View performance
bun run stats
```

---

## Configuration

Key environment variables (see `.env.example` for full list):

| Variable | Default | Description |
|----------|---------|-------------|
| `DRY_RUN` | `true` | Simulation mode — no real trades |
| `AMOUNT_SOL` | `0.1` | SOL per buy order |
| `MAX_OPEN_POSITIONS` | `1` | Max concurrent positions |
| `SCAN_INTERVAL_MINUTES` | `1` | Token discovery frequency |
| `MANAGE_INTERVAL_MINUTES` | `0.25` | Position monitoring frequency |
| `SLIPPAGE` | `0.15` | Slippage tolerance (15%) |
| `TEMPERATURE` | `0.15` | AI exploration level (0-1) |
| `SOLD_COOLDOWN_MINUTES` | `3` | Cooldown after selling a token |

### Token Filters

| Variable | Default | Description |
|----------|---------|-------------|
| `GMGN_TYPE` | `completed` | Token lifecycle stage |
| `GMGN_MIN_SMART_DEGEN_COUNT` | `3` | Minimum smart money wallets |
| `GMGN_MIN_RENOWNED_COUNT` | `2` | Minimum renowned traders |
| `GMGN_MAX_INSIDER_RATIO` | `0.10` | Maximum insider holding |
| `GMGN_MAX_CREATOR_BALANCE_RATE` | `0.11` | Maximum creator balance |
| `GMGN_MAX_CREATED` | `120m` | Maximum token age |
| `GMGN_LAUNCHPAD_PLATFORM` | `Pump.fun,pump_agent` | Launchpad filter |

---

## Architecture

```
Token Discovery (Screening)          Position Management (Managing)
        │                                      │
  fetchTrenchesTokens()                  getPositions()
        │                                      │
  filterCandidates()                  For each position:
        │                                getTokenDetails()
  getTokenDetails()                          │
  (4 API calls:                        getManageDecision()
   kline, traders,                     (AI: HOLD or SELL)
   tokenInfo, security)                      │
        │                               executeSellOrder()
  getBuySkipDecision()               or update position
  (AI: BUY or SKIP)
        │
  executeBuyOrder()
```

**Decision Flow:**
1. Screening scans for tokens every minute
2. Top candidates get full market analysis (kline, order flow, security)
3. AI decides BUY or SKIP based on signals + learned patterns
4. Managing monitors open positions every 30 seconds
5. AI decides HOLD or SELL based on PnL, momentum, and learned exit patterns
6. Every 30 decisions, learning system extracts new patterns
7. Patterns are scored and injected into next AI decisions

---

## Development

```bash
# Watch mode (auto-restart on changes)
bun run dev

# Production build
bun run build

# Run tests
bun test

# View performance dashboard
bun run stats
```

---

## Data Files

All trading data stored in `data/` (gitignored):

| File | Description |
|------|-------------|
| `trades.json` | Complete trade history |
| `positions.json` | Currently open positions |
| `decisions.json` | All AI decisions with context |
| `learnings.json` | Extracted trading patterns |
| `performance.json` | Aggregated performance metrics |
| `sold_tokens.json` | Cooldown tracking |

---

## Safety

- **Start with `DRY_RUN=true`** — always test in simulation before live trading
- **Trenches are extremely volatile** — tokens can go to zero in seconds
- **Never commit `.env`** — contains API keys and private keys
- **Start small** — use low `AMOUNT_SOL` values until agent proves stable
- **Not financial advice** — this is experimental software

---

## License

Private/Proprietary
