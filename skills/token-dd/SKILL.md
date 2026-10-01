# Token due diligence

How to spend the lookups on a row you are close to buying, and how to read what comes back.
Distilled from gmgn-skills 1.6.6 (contract-dd, dev-score, holder-analysis, kline-pattern) and
rewritten for the three tools you have. The thresholds are GMGN's, measured on their samples, not
on this engine's trades — a starting point, not a proven edge.

## Already done — do not spend a lookup on it

Before any buy the engine itself refuses honeypots, wash trading, buy/sell tax over 10% and, on
Solana, live mint/freeze authority or an unburned pool. Re-checking those wastes budget.

## Reading the numbers

- Every rate in `gmgn_token_info` is a 0-1 fraction, **including the ones named `*_percentage`**:
  `top_bundler_trader_percentage: "0.3406"` is 34%, not 0.34%. The thresholds below are percent —
  multiply first. `rug_ratio` in the brief is also 0-1 and the table uses it as-is.
- Numbers arrive as strings. Parse before comparing.
- **An empty `stat` block reads as zeros.** If `creator_hold_rate`, `top_bundler_trader_percentage`,
  `top70_sniper_hold_rate`, `top_rat_trader_percentage`, `top_entrapment_trader_percentage`,
  `bot_degen_rate`, `fresh_wallet_rate` and `creator_created_count` are *all* zero, GMGN has no
  analysis for this token: every `stat` check is unknown, not passed. One zero among non-zeros is real.
- Liquidity: use the non-zero of `liquidity` / `pool.liquidity`. `pool.initial_liquidity` is the
  opening depth of that pool; 0 means unknown, not drained.

## gmgn_token_info

**Hard flags — any one, do not enter:**

| Field | Flag |
|---|---|
| `rug_ratio` (brief) | ≥ 0.50 |
| `stat.top_bundler_trader_percentage` | > 30% |
| `stat.top_rat_trader_percentage` | > 5% |
| `stat.top_entrapment_trader_percentage` | > 50% |
| `stat.creator_hold_rate` | > 5% |
| liquidity | < $10K |
| `pool.liquidity / pool.initial_liquidity` | < 0.5 — the pool was drained since it opened |

**Warnings — count them:**

| Field | Warning |
|---|---|
| `rug_ratio` | 0.30 – 0.50 |
| `stat.top_bundler_trader_percentage` | 15 – 30% |
| `stat.top70_sniper_hold_rate` | > 15% |
| `stat.top_entrapment_trader_percentage` | > 20% |
| `stat.creator_hold_rate` | > 2% |
| `stat.bot_degen_rate` | > 70% |
| `stat.fresh_wallet_rate` | > 50% |
| `stat.top_10_holder_rate` | > 30% |
| `holder_count` | < 200 |
| liquidity | < $50K |
| `stat.creator_created_count` | ≥ 500 — a launch factory. Common on launchpads, so a warning, not a flag |
| `image_dup_count` | > 0 — the logo is reused elsewhere |

`dev.twitter_*` history and `link.*` text: read, never count. They describe an account's past or
are written by the deployer.

## gmgn_token_traders

Costs five times what info does. Use it only when info is clean but the holder set is small or
concentrated. Call it once with `order_by: amount_percentage`, `limit` about 20.

- One wallet holding > 10% of supply that is not the pool or a burn address → **hard flag**.
- Several top wallets funded from the same `native_transfer` source are one actor. Add their
  shares together and judge them as one wallet.
- Wallets tagged `bundler`, `sniper` or `rat_trader` together holding > 35% → **hard flag**.
- A `dev_team` / `creator` wallet still holding → warning.
- Profitable wallets whose `avg_sold` sits near the current price are selling into you → warning.

## gmgn_token_kline

Use `5m` with `limit` 60. For a token under an hour old use `1m`. Prices are strings, `time` is
milliseconds, `volume` is USD turnover and `amount` is the token count.

Under 8 candles, there is no pattern to read. Count that as a warning and size the stop off the
brief's 5m change instead.

Otherwise compute:

- `drawdown` = 1 − last close / highest high
- `slope` = mean of the last 5 closes against the mean of the 5 closes 20 bars earlier
- `range` = mean of (high − low) / close over the last 14 candles — this token's normal candle
- `vol_ratio` = mean volume of the last 20 candles / mean of the 20 before (needs 40 candles)

Pattern, first match wins:

| Pattern | Condition | Read |
|---|---|---|
| Breakdown | drawdown > 55% and slope < −10% | do not enter |
| Slow bleed | slope < −20% | do not enter |
| Bounce off the lows | drawdown > 55% and slope > 2% | warning — a dead-cat bounce until flow proves otherwise |
| Distribution at highs | drawdown > 35% and \|slope\| < 8% | warning |
| Vertical run-up | slope > 25% and drawdown < 12% | warning — you are the late buyer |
| Uptrend | slope > 8% and drawdown < 25% | the context you want |
| Consolidation | anything else | neutral |

Also a warning: `vol_ratio` < 0.20, meaning attention collapsed. Only this deep tier held up in
GMGN's test; do not warn on milder fades.

**The chart sizes the exit plan.** A stop inside the token's normal candle fills on noise, so put
the stop at least 2 × `range` below entry. If that is deeper than the stop the machine allows, the
token is too volatile for this envelope — skip it. Put the first take-profit above
`breakeven_pct` plus one `range`.

## From checks to conviction

- Any hard flag, or a "do not enter" pattern → leave it out of `entries`.
- 3 or more warnings → leave it out.
- 1 – 2 warnings → conviction 40 – 60. Name the warnings in the thesis, and know that the
  engine refuses anything at or below 60: that band is a pass, not a smaller buy.
- 0 warnings with an uptrend → conviction above 60 is earned.
- Unknown checks (empty `stat`, fewer than 8 candles) are not passes. Two or more unknowns cap
  conviction at 50.

## Thesis

Name what would prove you wrong, in numbers checkable next cycle — "5m sells overtake buys",
"price loses the alert cap", "drawdown passes 35%". An early exit is judged against that line.
