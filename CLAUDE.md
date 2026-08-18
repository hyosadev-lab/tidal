# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Runtime

Node 22+ running TypeScript directly (native type stripping) — no build step, no bundler,
**zero runtime dependencies**. `@types/node` is the only devDependency; `typescript` is a
peerDependency used for type-checking only.

This is deliberate: the code sticks to `fetch` + Node stdlib so it also runs under Bun and Deno.
Persistence is `node:sqlite` (stdlib, Node 22.5+; Bun 1.2+ and Deno 2.2+ implement the same
module) — do not reach for Bun-specific APIs (`Bun.serve`, `bun:sqlite`, `Bun.file`, `Bun.$`),
and do not add npm dependencies without being asked.

## Commands

```bash
npm start                                     # dashboard + engine → http://127.0.0.1:3111
npm test                                      # node --test, all *.test.ts
node --test src/trading/core/plan.test.ts     # one file
node --test --test-name-pattern="stop-loss"   # one test by name
npx tsc --noEmit                              # type check
npm run calibrate -- --limit=0                # is score() ranking anything? (--limit=0 spends nothing)
```

`GMGN_API_KEY` is required — every market read is an HTTP call to the GMGN OpenAPI.
`GMGN_PRIVATE_KEY` (a request-signing key, not a wallet key) is only needed for live mode:
it signs `swap` and `query_order`, the two routes GMGN requires a signature on. There is no
`gmgn-cli` dependency; `gmgn-skills/` is an untracked reference clone of its source, kept only
to look up endpoint shapes and field semantics, and excluded from `tsconfig.json`.

**One test file is not hermetic.** `src/trading/engine.test.ts` calls `engine.start()`, which
schedules a real scan 1.5s later; that scan hits the live GMGN API and writes to `data/tta.db`.
Expect network calls, a few seconds of runtime, and a mutated `data/` (gitignored). Point `TTA_DB`
at a scratch file to keep a test off the real ledger — `db.test.ts` does exactly that.
It also drives the shared `store` singleton. Every other test file is pure — put new tests in
`plan.test.ts` unless they genuinely need the network or the store. `npm test` loads `.env`
so the key is present.

## Architecture

One entry point: `src/index.ts` — static file server + JSON control API + SSE stream, driving
`src/trading/`. Its analyst is one LLM call per cycle (plus a capped few read-only GMGN lookups),
through `src/agent/llm.ts`.

There used to be a second: `src/cli.ts`, a readline chat loop with a `bash` tool and the full
GMGN tool set plus a skill loader (`src/agent/skills.ts`, `skills/`). All of it went with the
analyst's tools — nothing in the engine loaded it. `src/agent/tools.ts` now holds three of them
again, `gmgn_token_info`, `gmgn_token_kline` and `gmgn_token_traders` (`git log` it for the old,
much larger set).

### Storage

Everything persisted lives in one SQLite file, `data/tta.db`, opened by `src/trading/state/db.ts`
with `node:sqlite` — stdlib, so the zero-dependency rule holds. The split is by shape:
bounded state that the engine mutates in place (config, cash, open positions, cooldowns,
blacklist) is a JSON blob in `kv`; unbounded append-only series (`trades`, `equity`,
`soundings`, `outcomes`) are rows. WAL is on, so `calibrate.ts` reads while the engine trades.
The old `state.json` / `config.json` / `*.jsonl` are imported once on first open and renamed
`*.migrated`; that import is skipped when `TTA_DB` is set, so tests never touch `data/`.

`src/gmgn/` is the transport layer both entry points share: `endpoint.ts` (`OpenApiClient`, the
full GMGN OpenAPI surface — auth, signing, retries, and the one process-wide promise queue +
leaky bucket, since GMGN adds 5s to the cooldown per 429 and retry spam makes it worse),
`signer.ts`, and `client.ts` (the env-configured singleton). Two auth modes: *exist* (API key)
for reads, *signed* (API key + `X-Signature`) for the swap and order routes.

**Two limiters, and only one of them is documented.** The bucket's published numbers (rate 20,
capacity 20) describe the per-key limit; the 429s this project actually gets say *IP rate limit*
and are far stricter — measured twice on live cycles, ~18-20 weight inside one 30s window is the
wall, which is also the cooldown the 429 returns. So the bucket refills 20 tokens over 30s, not
over 1s (`GMGN_RATE_PER_SEC` overrides). Alongside it there is one process-wide gate: any 429
with a reset time closes it for *every* route until then and doubles the pacing gap, which
successes decay back. That gate is the fix for the real failure mode — a 429 is survivable, but
the two requests already queued behind it are what turn a 30s cooldown into `RATE_LIMIT_BANNED`.

`src/agent/llm.ts` is a ~80-line OpenRouter loop (`runAgent`) and the only file left under
`src/agent/`. It still supports tools (`{description, parameters (JSON Schema), run}`) and loops
until the model replies without tool calls; the analyst passes two read-only ones, so a cycle is
one request plus one more per lookup it spends.

### The central split (`src/trading/core/plan.ts` header states it; respect it)

**Gates, sizing, and exit *execution* are deterministic code. The model only ranks, writes theses,
and — in dynamic mode — proposes the shape of an exit plan.**
A position must never depend on an LLM call succeeding in order to be closed. The model can veto a
trade or request an early exit; it can never widen a risk limit. When adding features, keep new
risk logic in `plan.ts`/`config.ts` — not in prompts.

`cfg.fixedStrategy` picks who writes the plan. On: the operator's rows from the dashboard's exit
builder (`cfg.strategy`). Off: the analyst returns a `strategy` array per entry. Either way the
rules are snapshotted onto `Position.strategy` at entry by `entryStrategy` and run by
`evaluateExit` every monitor tick with no further model involvement — a proposal is clamped by
`sanitizeStrategy`, can't put a stop deeper than `cfg.stopLossPct`, gets a stop appended if it
omits one, and falls back to the config's stop/trail/ladder if it is unusable. An empty
`Position.strategy` is that legacy path.

**Who runs the plan depends on the mode.** In paper, `evaluateExit` does, every monitor tick.
In live, the same snapshot is translated by `broker.conditionOrders` and attached to the buy, so
*GMGN* runs it — all four rule kinds, trailing included (`profit_stop_trace` / `loss_stop_trace`),
sized off `sell_ratio_type: buy_amount` because `StrategyRule.sell` has always meant a share of
the original buy. The monitor then mirrors the wallet instead of racing it: it acts only on the
two things GMGN was never told, the time stop and `healthExit`, and books everything else from
the balance. That is why an exit plan must survive translation — a rule `conditionOrders` drops
is a rule that does not exist in live.

### `src/trading/` layering

Three folders and a root, and **imports only ever point inward**: `core/` imports nothing but
itself, `state/` and `exec/` import `core/`, and the root files assemble all three. Nothing in
`core/` may import from `state/`, `exec/`, or the root — that rule is what keeps `core/plan.ts`
testable without opening the database or the API client. A new file goes in the deepest folder
whose rule it can still obey.

| File | Role |
|---|---|
| `core/types.ts` | shared types, no logic |
| `core/config.ts` | defaults, per-chain constants, `num`, `sanitizeConfig` (every dashboard input is clamped here — these bounds are safety limits, not input tidying), `liveReady`. Imports nothing but `types.ts` — keep it that way |
| `core/plan.ts` | pure functions: `toCandidate`, `runGates`, `score`, `positionSize`, `evaluateExit`, `healthExit`, `isDust`. No I/O, and importing it must not open the database or the API client — this is where tests concentrate |
| `core/fixtures.ts` | `candidate()` / `position()` builders; only `*.test.ts` imports it |
| `state/db.ts` | the one SQLite file (`data/tta.db`) via `node:sqlite`; schema, `kv` helpers, row writers, one-shot import of the pre-SQLite JSON files. `TTA_DB` overrides the path. **`ROOT` is counted from this file's own location** — moving the file moves `data/` |
| `state/store.ts` | **module-level singleton** `store`; mutable state in `kv.state` (debounced), trades + equity as rows, pub/sub for SSE |
| `state/soundings.ts` | append-only table of every scanned candidate + its price at scan time; written by the scan, costs no API call |
| `exec/market.ts` | what the engine asks GMGN, in the engine's vocabulary: feeds, normalisation, prices, swap wrappers. The **cast boundary** — `OpenApiClient` returns `unknown`, nothing outside this file speaks HTTP or touches `gmgnClient()` |
| `exec/broker.ts` | paper vs live execution of buy/sell; the only place that submits swaps |
| `analyst.ts` | the model half of a cycle: the prompts (`systemPrompt`, `exitPlan`, `describeRule`), the cycle brief, `askAnalyst`, `extractJson`. One LLM call, two read-only tools on a per-cycle budget, spends nothing |
| `engine.ts` | scan loop (interval minutes) + monitor loop (30s), entries and exits, lifecycle. `bookSell` is the one post-sell path both `closePosition` and `reconcile` run through |
| `calibrate.ts` | offline: re-prices those rows later and reports whether `score()` ranked anything. Reads only; never trades |

Data flow per cycle: `gatherCandidates` (4 GMGN feeds, deduped) → `runGates` + `score` →
top 18 eligible → `askAnalyst` (LLM returns JSON `{entries, exits, notes}`) → `buyableSet` →
`broker.buy/sell` → `store` mutation → `store.emit` → SSE → `public/app.js`. The monitor loop runs
independently and never touches the LLM.

**`gatherCandidates` is the whole search, and the brief is the near-whole evidence base.** The
analyst can deep-dive a row it already has (info + kline, 6 lookups per cycle), but it cannot
search: an address outside the brief never went through `toCandidate` or the gates, so there is
nothing to size and `buyableSet` refuses it. **Both lookups are now mandatory per entry** — the
prompt requires `gmgn_token_info` *and* `gmgn_token_kline` on every address the analyst puts in
`entries`, so the budget of 6 is 3 fully-researched entries per cycle. That pairing is deliberate:
`/v1/token/info` is much richer than the brief and carries most of what the feeds leave blank —
bundler and sniper concentration (`stat.top_bundler_trader_percentage`, `top70_sniper_hold_rate`),
`fresh_wallet_rate`, `bot_degen_rate`, dev status and deployer history (`dev.creator_token_status`,
`stat.creator_created_count`), `pool.initial_liquidity` against current, `ath_price`, and the
buy/sell *volume* split that neither feed reports. The tool's description in `src/agent/tools.ts`
is the field inventory, written from live responses — keep it that way, since it is the model's
only view of the route. What stays a stated blank is only what neither the brief nor those two
routes carries. The operator steers
the sweep through the dashboard's Refine panel
(`refineQuery`), not through the prompt — `cfg.prompt` shapes selection, not fetching, because the
sweep runs before the model is called. Everything the model needs must therefore be on the
candidate row: widening the analyst's view usually means adding a field in `askAnalyst`'s
`brief` — a field the sweep already fetched costs nothing, a new tool costs the sweep's tokens.

## Invariants worth knowing before you edit

- **Never set `GMGN_ALLOW_AUTOMATED_TRADES` from code.** `OpenApiClient` throws on every route
  that spends — swap, multi-swap, strategy create, token create — if it isn't already in the
  environment. That variable is the operator's standing consent to headless execution;
  the process is not entitled to grant it on their behalf. Same reasoning behind `liveReady()`.
  This process signs its own trade requests, so that check is now the *entire* barrier — there is
  no second process left to refuse on our behalf. Don't add a config knob that substitutes for it.
- **The analyst's tools are three read routes and nothing else.** `askAnalyst` passes
  `budgetedTools(LOOKUP_BUDGET)` from `src/agent/tools.ts` — `gmgn_token_info`,
  `gmgn_token_kline` and `gmgn_token_traders` (the holder set wallet by wallet: cost basis,
  whether they are still in, and the wallet that funded them — bucket weight 5, the most
  expensive of the three), all `exist`-auth reads through `market.ts`. The unattended loop still
  cannot reach a shell, a spend route or the operator's wallet, because no such tool exists in
  that record. Keep it that way: add read-only routes one named tool at a time, never a shell,
  never a route that spends, and never the record wholesale from somewhere else.
- **`securityRisk` is a pre-trade refusal, not a gate, and that is deliberate.** It runs once per
  entry in `openPosition` (paper and live alike) against `token_security`, because only that route
  answers reliably — `trenches` rows report `renounced_*: false` on tokens the security route
  reports as `true`, so gating on a feed row would kill the whole feed. Runs on every chain now:
  the tax half (`buy_tax`/`sell_tax` > 10%) applies everywhere, the mint/freeze and burn halves
  are Solana-only — those authorities do not exist on EVM and EVM liquidity is locked rather than
  burned. Fails closed on all chains, so EVM entries now cost one `token_security` call each.
  Measured on live candidates: the authority half never fires (launchpads revoke at creation),
  the burn half refuses about 1 in 14 otherwise-clean candidates.
- **`runGates` no longer screens structure — that was an operator decision, not an oversight.**
  It rejects wash trading, honeypots, and rows with no address or no price. That is all. The
  graded properties it used to gate on (smart-money count, `rug_ratio`, top-10 rate, liquidity
  depth, dev still holding) are read, scored by `score()`, shown to the analyst, and filterable
  per-feed from the dashboard's **Refine** panel — but they disqualify nothing. Consequence to
  keep in mind when editing: a candidate with a $2k pool, no smart money and a dev still holding
  reaches `askAnalyst` looking like any other row, and only the analyst, the Refine filters and
  `securityRisk` stand between it and a position. `SKIP` is gone entirely: `gatherCandidates`
  sends only the operator's Refine rows, so a blank Refine fetches the feeds unfiltered. Don't
  reintroduce a structural gate — or a hardcoded feed floor — without asking: the dashboard is
  where that policy lives now.
- **A cycle costs one LLM call plus at most `LOOKUP_BUDGET` (6) GMGN reads.** The budget is
  enforced in `budgetedTools`, not in the prompt: calls past it return a refusal string, so the
  model answers from the brief instead of erroring. `maxSteps` is `LOOKUP_BUDGET + 2`, and going
  over it throws — a cycle that no-ops. Raising the budget takes tokens straight out of the
  sweep's share of the same process-wide bucket (20 per 30s, IP-scoped), which is what starves
  the candidate list; measure before you raise it.
- **In live mode the wallet, not the ledger, says what is still held.** The whole exit plan runs
  on GMGN's side, so positions shrink and disappear without this process selling anything — and
  the operator can sell from GMGN's UI too. One `walletHoldings` read per monitor tick (not per
  position) is the mirror; `reconcile` in `engine.ts` books whatever left through
  `broker.recordExternalSell`, which submits nothing and prices the slice at the last seen price,
  so that trade's PnL is an estimate. A wallet that cannot be read, and an address the holdings
  page did not carry, both close nothing — only an explicit zero balance does. When this process
  *does* sell a live position itself, `withdrawExitPlan` cancels the strategy order GMGN is still
  holding, so it cannot wake up against a later balance of the same token.
- **`priority_fee` and `tip_fee` are mandatory on any swap carrying `condition_orders`** (SOL
  needs both, BSC needs the tip; EVM chains want the gas fields instead). On Solana the numbers
  come from the chain itself — `market.gasQuote` reads `auto` / `auto_mev` off the same
  `/v1/chain/gas_price` call the buy already makes for the native price, so live pricing costs
  nothing extra. `PRIORITY_FEE` / `TIP_FEE` in `config.ts` are the fallback for the chains that
  route does not answer for, and `GMGN_PRIORITY_FEE` / `GMGN_TIP_FEE` override everything. GMGN
  rejects the swap outright when one is missing, so a protected buy silently becomes no buy.
- **`buyableSet` is the last word on what can be bought.** It re-checks gates, cooldown,
  blacklist and open positions in `engine.ts` immediately before entries — deliberately *after*
  the model's requested exits have run, since closing a position puts its address straight onto
  cooldown. An address the analyst names that is not in the set is logged and skipped, with the
  address included in the log line: a mistyped or omitted one is indistinguishable from a gate
  failure without it.
- **Token names/symbols are attacker-controlled data.** The system prompt says so; don't add code
  paths that treat scanned text as instructions.
- **GMGN percent conventions differ per field.** `rug_ratio` and `top_10_holder_rate` are ratios
  (0–1); `price_change_percent1h`/`5m` already arrive as percent. Mixing them silently breaks gates.
- **The two feeds do not carry the same columns, and `num()` turns that into a lie.** The rank
  feed has `price_change_percent1m`, `buys`/`sells`, `gas_fee`; trenches has `buys_24h`/
  `sells_24h`, `net_buy_24h`, `suspected_insider_hold_rate`, `total_fee`, and no price change at
  all. The same measure often has two names (`bundler_rate` / `bundler_trader_amount_rate`).
  Fields only one feed reports are typed `number | null` on `Candidate` and mapped with
  `numOrNull`, because `num()` would report "not measured" as a clean zero — the dashboard prints
  those as `—` and the brief passes the null through. Buy/sell *volume* is on neither feed;
  only the counts and the trenches net figure are. Windows differ too: `volume1hUsd`/`swaps1h`
  fall back to the 24h columns on trenches rows, so they are not comparable across sources.
- **The `smart-money` feed (signal type 12) carries no flow at all.** Measured live: `volume_*`,
  `swaps_*`, `buys_*`, `sells_*` and `net_buy_*` are 0 on every window, and `smart_degen_count`
  is 0 even though the signal *is* a smart-money buy — structure, holders and `renowned_count`
  are populated. Because a row it alone surfaced would carry no flow to judge, **it is a label,
  not a source**: `mergeFeeds` runs it last and drops any address the rank feeds did not already
  produce, so a `smart-money` tag always sits beside `trending-*` or `graduated` and the numbers
  are that feed's. It is also the one feed Refine barely reaches — the route takes market-cap
  bounds and nothing else the panel offers. And it returns **one row per alert**, so the same
  token arrives several times: the merge collapses repeated source labels for that reason.
- **Signal types are groups inside one request, so a second type is free.** `ALERTS` in
  `engine.ts` is the whole list — type number and the label it leaves — and it drives both the
  request and `SIGNAL_LABELS`, so adding a type is one row there. All of them ride a single POST
  (the route bills per call, not per group) and the rows are split back apart by `signal_type`.
  Queryable types are 1–13 and 17–20; 14–16 the API refuses. What decides whether a type earns a
  label is its overlap with the rank feeds, since nothing else survives the merge — one live
  sweep: 3 → 20/50, 11 → 18/50, 12 → 17/41, 6 → 12/46, 13 → 9/28, 7 → 1/50 (which is why 7 is
  out). GMGN publishes no number-to-event mapping, so only three are named from evidence:
  12 is smart money (its own docs say so), 6 price spike, and 11 CTO (`cto_flag` true on 50/50
  rows). 3 and 13 keep their numbers rather than a guessed name. No type carries flow — the one
  number the merge keeps off an alert row before discarding it is `trigger_mc`, the market cap
  when the alert fired, carried onto the ranked row as `Candidate.triggerMcUsd` and reaching the
  analyst as `alert_mcap_usd`. First alert wins. Against `mcap_usd` it is the only thing an alert
  says that a rank feed cannot; measured on one live sweep the median tagged row sits at 0.61x
  its alert cap and only 11 of 46 are above it.
- **Take-profit rungs sell a % of `originalQty`**, but a live percent sell is a % of the *current
  wallet balance* — `broker.sell` converts between the two. On the wire that percent becomes
  `input_amount_bps` (basis points: 50% → `"5000"`) and `input_amount` is a `"0"` placeholder.
- **`kline` takes milliseconds**; every other timestamp in `market.ts` is seconds.
- **In live mode, sizing comes from the real wallet** (`syncLiveBalance` → `/v1/user/info`),
  not the paper bankroll. If the balance can't be read, entries are skipped for that cycle rather
  than sized off a guess — GMGN rate-limits `insufficient token balance` errors specifically.
- Per-chain floors exist for a reason: `MIN_POSITION_USD` (round-trip friction) and `GAS_RESERVE`
  (a fully deployed wallet must still be able to pay to exit).

## Frontend

`public/` is vanilla HTML/CSS/JS with no build step — `src/index.ts` serves the directory as-is and
`app.js` consumes `/api/stream` (SSE). Keep it dependency-free.

## Extending

- **More for the analyst to judge on**: add the field to the `brief` object in `askAnalyst`, from
  data the sweep already fetched. Not a tool — the analyst has none, and a new GMGN call per
  candidate is paid out of the sweep's rate limit.
- **New GMGN route**: add it to `OpenApiClient` in `src/gmgn/endpoint.ts` and wrap it in
  `market.ts`, which is the cast boundary. Nothing above `market.ts` speaks HTTP.
- **A tool, if it ever comes back**: `src/agent/tools.ts` is the empty template — shape,
  schema rules and the allowlist discipline are in its header.
- **New config knob**: `types.ts` → `DEFAULT_CONFIG` → a clamp in `sanitizeConfig` → the UI.
