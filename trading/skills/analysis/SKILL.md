---
name: analysis
description: What the GMGN fields actually mean before you act on them — which are ratios and which are already percentages, which are chain-specific and silently meaningless on the wrong chain, and how to read holders, dev status and smart-money flow. Load this before judging a specific token with token_detail, token_security, top_holders or smart_money_flow.
---

# Reading the numbers

The single most expensive mistake here is treating a ratio as a percentage. The feeds mix
both conventions in the same row.

**Ratios, 0–1.** `rug_ratio`, `top_10_holder_rate`, `dev_team_hold_rate`, `bundler_rate`,
`insider_rate`, `rat_trader_amount_rate`, `fresh_wallet_rate`, `amount_percentage` (in
`top_holders`). `0.34` here means 34%.

**Already percentages.** `price_change_percent1h`, `price_change_percent5m`,
`change_1h_pct` and `change_5m_pct` in the candidate brief. `16.6` means +16.6%.

**USD, not token units.** `volume` and `liquidity` are dollars. In `price_history`, `v` is
dollar volume — the token-unit count is a different field and is not exposed here.

## Fields that mean nothing on the wrong chain

- `is_honeypot` is **EVM-only** (bsc, base, eth). On Solana it comes back empty. Empty does
  not mean safe — it means the check did not run. Do not cite "not a honeypot" on a sol token.
- `renounced_mint` and `renounced_freeze_account` are **Solana-only**. Both true is the
  baseline safety expectation there. On EVM the concept does not exist and the fields are false.

## Risk fields

| Field | Read it as |
|---|---|
| `rug_ratio` | 0–1 rug likelihood. Above 0.3 is high risk and already blocked by the gates. Below 0.1 is clean. Not binary — weigh it with concentration and dev status. |
| `top_10_holder_rate` | Under 0.20 is healthy, 0.20–0.50 needs a reason, above 0.50 means ten wallets can end the trade. |
| `dev_status` / `creator_token_status` | `creator_close` = the dev sold or burned their allocation, the overhang is gone. `creator_hold` = the dev can still dump on you. |
| `bundler_rate` | Share of launch buys that were bot-bundled. Above 0.3 the early price action was manufactured. |
| `insider_rate` / `rat_trader_amount_rate` | Insider and sneak-trading share. Above 0.3, assume someone is positioned ahead of you. |
| `is_wash_trading` | Coordinated fake volume. Already a hard gate — if you see it, the volume number above it is fiction. |
| `cto_flag` | Original dev walked, community took over. Neutral to mildly positive; judge on what the community actually did since. |
| `burn_status` / `burn_ratio` | `"burn"` / a ratio above 0 means the LP tokens are destroyed and the deployer cannot withdraw the pool. `"none"` means they can, whenever they like. |

**Liquidity burn is a hard pre-trade requirement on Solana.** Before any entry the engine
re-reads `token_security` and refuses the buy if the pool is not burned, if the mint or freeze
authority is still live, or if the response cannot be read at all. You cannot override it and
you will not see it in the candidate brief, so on sol it is worth calling `token_security`
yourself on a name you are about to commit to — roughly one in fourteen otherwise-clean
candidates fails this, and naming one in `entries` spends a slot on a refusal.

Mint and freeze authority in practice: Solana launchpads revoke both at creation, so they are
renounced on essentially everything you will see. Treat them as a backstop, not a signal, and
do not present "authority renounced" as a reason to buy. Liquidity burn is the one that varies.

## Holders

`top_holders` returns per-wallet rows. What matters is not the list but the shape of it:

- `pct` — share of supply. One non-pool wallet above ~5% is a single-point failure.
- `sold_pct` — how much of what they bought is already gone. A top holder past 50% sold is
  distributing into the move you are considering joining.
- `avg_cost` versus current price — holders deep in profit have every reason to take it.
  Holders near or under water are less likely to be your exit liquidity.
- `tags` — `smart_degen`, `renowned` (KOL), `dev`, `sniper`, `bundler`, `rat_trader`,
  `fresh_wallet`. Tags on the *top* holders matter more than raw counts: three smart-money
  wallets in the top ten is a different token than three smart-money wallets in the top two
  hundred.
- Filter with the `tag` parameter when you want one specific group rather than the top by size.

Independence is what you are testing. Several unconnected smart-money wallets accumulating is
a signal; several wallets that entered within the same block at the same cost is one wallet.

## Smart-money flow

`smart_money_flow` is chain-wide recent activity, not per-token. Fields:

- `side` — `buy` or `sell`.
- `full_position` (`is_open_or_close`) — `1` means a full position open or close, `0` means a
  partial add or reduce. A full open is a conviction signal; a partial add is a nibble. Note
  that the polarity of this field differs between GMGN endpoints, so treat it as "was this the
  whole position" rather than "was this a buy".
- `usd` — size. A tagged wallet putting in $200 is not a thesis.

Smart money *selling* a token you hold is one of the few things worth requesting an early exit
for, because the mechanical rules cannot see it.

## A workable order of operations

1. Start from `structure_score` and the brief. It already encodes liquidity depth, volume
   against market cap, and how extended the move is.
2. `token_detail` on the two or three you actually care about. Check `smart_wallets` and
   `renowned_wallets` against `holder_count` — ten smart wallets among 300 holders is a
   different claim than ten among 30,000.
3. `top_holders` when the concentration number is borderline or the story rests on smart money.
   This is where a thesis usually dies.
4. `price_history` when you need to know whether you are buying a base or a blow-off top.
   A move already past roughly +150% in an hour means you would be the exit liquidity.
5. `token_security` when something feels off and you want the audit view.

Stop early when a step disqualifies the token. Budget spent confirming a rejection is budget
not spent on the candidate that deserved it.

## What this analysis cannot change

Gates, position size, stop-loss, take-profit rungs, trailing stops and the time stop are all
enforced in code, every 30 seconds, whether or not you are reachable. Your conviction scales
size within the operator's risk budget; it does not widen it. Nothing you write in a thesis
keeps a position open past its stop.

Prefer no trade to a marginal trade. An empty `entries` array is a complete answer.
