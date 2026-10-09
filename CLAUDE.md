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
npm test                                      # node --test, all tests/**/*.test.ts
node --test tests/core/domain/positions.test.ts # one file
node --test --test-name-pattern="stop-loss"   # one test by name
npx tsc --noEmit                              # type check
npm run calibrate -- --limit=0                # is score() ranking anything? (--limit=0 spends nothing)
```

`GMGN_API_KEY` is required — every market read is an HTTP call to the GMGN OpenAPI.
`GMGN_PRIVATE_KEY` (a request-signing key, not a wallet key) is only needed for live mode:
it signs `swap` and `query_order`, the two routes GMGN requires a signature on. There is no
`gmgn-cli` dependency; `gmgn-skills/` is an untracked reference clone of its source, kept only
to look up endpoint shapes and field semantics, and excluded from `tsconfig.json`.

**Live Solana does not swap through GMGN.** It goes through Jupiter Swap V2
(`src/core/market/jupiter.ts`: `/order` → sign → `/execute`), signed in-process with
`SOLANA_PRIVATE_KEY` — a real wallet key, base58 or JSON array. `JUPITER_API_KEY` is optional
(keyless is 30 requests/min), `SOLANA_RPC_URL` overrides the public RPC used for the wallet's
SOL balance, a mint's decimals and a token balance. GMGN is still every market read, and still
the swap route on the other chains.

**One test file is not hermetic.** `tests/core/cycle/cycle.test.ts` calls `start()`, which
schedules a real scan 1.5s later; that scan hits the live GMGN API and writes to `data/tta.db`.
Expect network calls, a few seconds of runtime, and a mutated `data/` (gitignored). Point `TTA_DB`
at a scratch file to keep a test off the real ledger — `db.test.ts` does exactly that.
It also drives the shared `store` singleton. Every other test file is pure. Tests live under `tests/`, which
mirrors `src/` (`tests/core/domain/gates.test.ts` pins `src/core/domain/gates.ts`, …) — put a new
test in the one named after the file you changed (the `candidate()` / `position()` builders are in
`tests/core/domain/fixtures.ts`), and in `cycle/cycle.test.ts` only if it genuinely needs
the network or the store. `npm test` loads `.env`
so the key is present.

## Architecture

One entry point: `src/index.ts` — static file server + JSON control API + SSE stream, driving
`src/core/`. Its analyst is one LLM call per batch of due tokens (plus a capped few optional read-only GMGN lookups),
through `src/agent/llm.ts`.

There used to be a second: `src/cli.ts`, a readline chat loop with a `bash` tool and the full
GMGN tool set plus a skill loader. All of it went with the
analyst's tools — nothing in the engine loaded it. `src/agent/tools.ts` now holds five of them
again, `gmgn_token_info`, `gmgn_token_kline`, `gmgn_token_traders`, `gmgn_token_holders` and
`gmgn_market_signal` (`git log` it for the old, much larger set).

### Storage

Everything persisted lives in one SQLite file, `data/tta.db`, opened by `src/core/data/db.ts`
with `node:sqlite` — stdlib, so the zero-dependency rule holds. The split is by shape:
bounded state that the engine mutates in place (config, cash, open positions, cooldowns,
blacklist) is a JSON blob in `kv`; unbounded append-only series (`trades`, `equity`, `logs`,
`soundings`, `outcomes`) are rows. WAL is on, so `calibrate.ts` reads while the engine trades.
The old `state.json` / `config.json` / `*.jsonl` are imported once on first open and renamed
`*.migrated`; that import is skipped when `TTA_DB` is set, so tests never touch `data/`.

`src/gmgn/` is the transport layer both entry points share: `endpoint.ts` (`OpenApiClient`, the
full GMGN OpenAPI surface — auth, signing, retries, and the one process-wide promise queue +
leaky bucket, since GMGN adds 5s to the cooldown per 429 and retry spam makes it worse),
`signer.ts`, and `client.ts` (the env-configured singleton). Two auth modes: *exist* (API key)
for reads, *signed* (API key + `X-Signature`) for the swap and order routes.

**The bucket charges GMGN's published weights against the free plan.** Plans are Free 5/5,
Plus 20/20, Pro 50/50 (rate/capacity), and each route has a weight — rank 3, trenches 2, kline 2,
`user/info` 2, top holders/traders 5, swap and quote 10, most token reads 1; the `ROUTE` table in
`endpoint.ts` is the full list, copied from the "Rate Limits" section of each gmgn-skills SKILL.md.
Capacity defaults to 5. The refill does not: measured on a free key it sits between 0.67 and 1.18
weight/s, not the 5/s "rate 5" suggests, so the bucket refills 20 per 30s (`GMGN_RATE_PER_SEC` /
`GMGN_RATE_BURST` override, and are the two knobs to turn on a paid plan). At those numbers the
sweep is rank, 3s, rank, 3s, trenches, and a whole cycle of reads (~25 weight) takes ~30s — measured
clean. Keep the weights honest when adding a route: the old table booked the sweep as 5 while the
server counted 8, which is what 429'd the graduated feed on every fresh start. Alongside the bucket
there is one process-wide gate: any 429 with a reset time closes it for *every* route until then
and doubles the pacing gap, which successes decay back. That gate is for what the bucket cannot
see (a second process, a restart) — a 429 is survivable, but the two requests already queued
behind it are what turn a 30s cooldown into `RATE_LIMIT_BANNED`. Reads retry once after waiting
out a reset of up to 35s; swaps never retry.

`src/agent/llm.ts` is a ~80-line OpenRouter loop (`runAgent`). It still supports tools (`{description, parameters (JSON Schema), run}`) and loops
until the model replies without tool calls; the analyst passes two read-only ones, so a cycle is
one request plus one more per lookup it spends.

### The central split (`src/core/domain/positions.ts` header states it; respect it)

**Gates, sizing, and exit *execution* are deterministic code. The model only ranks, writes theses,
and — in dynamic mode — proposes the shape of an exit plan.**
A position must never depend on an LLM call succeeding in order to be closed. The model can veto a
trade or request an early exit; it can never widen a risk limit. When adding features, keep new
risk logic in `domain/` — not in prompts.

`cfg.fixedStrategy` picks who writes the plan. On: the operator's rows from the dashboard's exit
builder (`cfg.strategy`). Off: the analyst returns a `strategy` array per entry. Either way the
rules are snapshotted onto `Position.strategy` at entry by `entryStrategy` and run by
`evaluateExit` every monitor tick with no further model involvement — a proposal is clamped by
`sanitizeStrategy`, can't put a stop deeper than `cfg.stopLossPct`, gets a stop appended if its
stops do not cover the whole position, and falls back to the config's stop/ladder if it is
unusable. An empty `Position.strategy` is that legacy path.

**There are two rule kinds, `tp` and `sl`, and a plan may hold several of each** — a ladder of
take-profits, a staged stop. Each fires once and sells its `sell`% of the original size. When
one tick reaches more than one, the furthest wins on both sides (deepest stop, highest rung).
Trailing rules (`ttp` / `tsl`, and the config's `trailArmPct`) were removed on the operator's
decision: nothing follows the price up, so a gain is only locked in by a `tp` that fills. Don't
bring one back without asking. A position opened before the removal may still carry a trailing
rule in the ledger; `ruleExit` ignores a kind it does not know, so it simply never fires.

**Who runs the plan depends on the mode.** In paper, `evaluateExit` does, every monitor tick.
In live, the same snapshot is translated by `broker.conditionOrders` and attached to the buy, so
*GMGN* runs it — every `tp` as a `profit_stop` and every `sl` as a `loss_stop`,
sized off `sell_ratio_type: buy_amount` because `StrategyRule.sell` has always meant a share of
the original buy. The monitor then mirrors the wallet instead of racing it: it acts only on the
two things GMGN was never told, the time stop and `healthExit`, and books everything else from
the balance. That is why an exit plan must survive translation — a rule `conditionOrders` drops
is a rule that does not exist in live.

**On Solana nobody else runs the plan.** Jupiter is the swap and nothing more, so a live Solana
position is run by the monitor exactly as a paper one: `evaluateExit` every tick, each rung its
own `jupiter.swap`. It used to be parked as Jupiter Trigger V2 orders (`git log` for
`parkExits` / `triggerSlices`); the operator took that out, because Jupiter refuses an order
under $10 — confirmed live: `Order must be at least 10 USD` — and that folded a small ladder
into one leg. The cost is stated plainly: **a Solana position has no stop while this process is
down.** Don't bring the parking back without asking.

**Between ticks, a streamed price.** With `HELIUS_API_KEY` set, a Solana position on a pool
`market/helius.ts` can read is priced on every swap, and `monitor.onStreamPrice` runs the same
plan against it at once instead of up to `monitorSeconds` later. Three things to keep in mind:

- **One pool shape only: `pump_amm` quoted in SOL.** Anything else (`poolRef` returns null — a
  PUMP-quoted pool, a CLMM, a bonding curve) stays on the tick. Each shape is its own arithmetic.
- **The price is not the vault ratio.** A pump_amm pool adds a virtual quote reserve (~17.6 SOL,
  a u64 at byte 245 of the pool account) to its SOL side; the bare ratio ran 10-74% under GMGN's
  price on live pools. That offset is reverse-engineered, so a stream is only acted on after one
  streamed price has landed within 20% of a GMGN read (`syncStream`) — otherwise it is switched
  off for that position with a warning.
- **The tick is still the loop.** The wallet mirror, `healthExit` and the time stop run only
  there, and a stream that goes quiet for 15s hands the price back to GMGN. Stop closes every
  stream (`stopStreams`): a stream that outlived Stop would sell.

### Two loops: fetch the tokens, analyse what is due

Fetching and analysing are separate, joined only by a kick (`fetchThenAnalyse` in `runtime.ts`):

- **Fetch** (`cycle/scan.ts`, every `FETCH_SECONDS` = 60): the three feeds, gated and scored,
  left in `store.pool`. No model, no lock, no buying. A fetch the rate limiter holds past the
  minute makes the next one a no-op rather than stacking.
- **Analyst queue** (`cycle/analyse.ts`): kicked after every fetch, it sends every token that is
  due in one LLM call — the answer is `entries`, `exits` and a `recheck` time per token — and
  `openEntries` is handed that batch, so the analyst can buy nothing it was not just shown.

`dueNow` in `domain/candidates.ts` is the queue: every eligible row that is due, best score
first. A token never judged is due now, so **a newly surfaced token is analysed straight after
the fetch that carried it** (`first_look: true` on its row). **The analyst sets when each token
is due again** — `recheck: [{address, minutes}]`, clamped 1–30 in `analyse.ts`, not in the
prompt, and ignored for an address outside the batch. `RECHECK_DEFAULT_MINUTES` (15, a constant
there) is the fallback for a token it left out — the dashboard slider was removed on the
operator's decision. The due-at map is `store.analysed`, in memory only — a restart re-reads
the feed from scratch, so the first call after one carries the whole pool (~100 rows). The batch
is marked with the fallback before the call, so a failed call cannot spin on the same rows; a
null decision (dead key, model down, unparseable reply) ends the drain and the next fetch retries.

It was one token per call for a few hours (`git log`); the operator changed it to a batch.

Things to keep in mind:

- **One drain at a time** (`claim`/`release` in `control.ts`). A kick that lands during a drain
  is a no-op; the running drain reads the fresher `store.pool` as soon as its call is back.
- **The queue does not run with every slot taken.** Nothing could be bought and each call is
  paid for. The cost: the analyst's early `exits` are only asked for while a slot is free. The
  exit plan, `healthExit` and the time stop never needed the model.
- **The cost is the analyst's to run up:** a call goes out after any fetch that has something
  due, so an analyst that answers 1 on everything is a full-pool call every minute.
- **Soundings are sampled**, one fetch in 15 minutes (`SOUNDING_MINUTES` in `scan.ts`), not
  every fetch: at one a minute the table would grow ~150k rows a day.
- There is no watchlist. It was removed on the operator's decision (`git log` for
  `domain/watchlist.ts` / `cycle/watch.ts`); "wait and see" is now just a pass, and the token
  comes back with fresh numbers after the cooldown. Don't bring it back without asking.

A loss halt stops the fetch timer, and the queue with it.

### `src/core/` layering

Four folders and two root files, and **imports only ever point inward**:

```
domain/   pure rules — imports nothing but itself
data/     persistence — imports domain/
market/   GMGN-facing — imports domain/
cycle/    one cycle's steps — imports domain/, data/, market/, and cycle/control.ts
runtime.ts  assembles all of it; nothing imports it back except src/index.ts
```

Nothing in `domain/` may import from `data/`, `market/`, `cycle/` or the root — that rule is
what keeps the rules testable without opening the database or the API client. A new file goes
in the deepest folder whose rule it can still obey. `cycle/control.ts` is the one exception
worth knowing: every step imports it, so it imports no step (the timer callbacks are passed
in, not imported).

| File | Role |
|---|---|
| `domain/types.ts` | shared types, no logic |
| `domain/num.ts` | `num`, `numOrNull`, `truthy`, `clamp`, `short` — the coercions every wire value passes through, so the pure layer can read a feed row without the HTTP client |
| `domain/chains.ts` | per-chain constants and the fee arithmetic on them: `NATIVE`, `MIN_POSITION_USD`, `GAS_RESERVE`, `SWAP_FEE_PCT`, `netOfFees`, `breakevenPct` |
| `domain/config.ts` | `DEFAULT_CONFIG`, the Feed filters spec, `sanitizeConfig` (every dashboard input is clamped here — safety limits, not input tidying), the derived reads (`tradeSize`, `minPosition`, `slippage`), `liveReady` |
| `domain/candidates.ts` | `toCandidate` + `buyableSet`: a feed row becomes a `Candidate` here and only here. Also `dueNow`, the analyst's queue |
| `domain/gates.ts` | what disqualifies a row and what ranks the rest: `runGates`, `gateTally`, `securityRisk`, `score` |
| `domain/positions.ts` | size it, plan its exit, decide when it leaves: `positionSize`, `entryStrategy`, `evaluateExit`, `healthExit`, `isDust`. **The central split is stated in this file's header** |
| `data/db.ts` | the one SQLite file (`data/tta.db`) via `node:sqlite`; schema, `kv` helpers, row writers, one-shot import of the pre-SQLite JSON files. `TTA_DB` overrides the path. **`ROOT` is counted from this file's own location** — moving the file moves `data/` |
| `data/store.ts` | **module-level singleton** `store`; mutable state in `kv.state` (debounced), trades + equity + log lines as rows, pub/sub for SSE. `store.unavailable(address)` is the one answer to held / cooldown / blacklist |
| `data/soundings.ts` | append-only table of every scanned candidate + its price at scan time; written by the scan, costs no API call |
| `market/gmgn.ts` | what the engine asks GMGN, in the engine's vocabulary: feeds, normalisation, prices, swap wrappers. The **cast boundary** — `OpenApiClient` returns `unknown`, nothing outside this file speaks HTTP or touches `gmgnClient()` |
| `market/jupiter.ts` | the Solana execution route: Jupiter Swap V2 order/sign/execute, base58 and ed25519 signing on `node:crypto`, three Solana RPC reads. The cast boundary for Jupiter, as `gmgn.ts` is for GMGN |
| `market/helius.ts` | real-time price for a Solana position: Helius websocket `accountSubscribe` on a pump_amm pool's two vaults and its pool account, price = (quote vault + virtual quote) / base vault. The cast boundary for Helius. Optional — without `HELIUS_API_KEY` nothing here runs |
| `market/broker.ts` | paper vs live execution of buy/sell; the only place that submits swaps. Live branches by chain: Solana → `jupiter.swap` and the monitor runs the exits, the rest → `gmgn.swap` with condition orders |
| `cycle/control.ts` | the run's mutable state: the generation a Stop bumps (`generation`/`aborted`), the timer handles (`arm`/`disarm`), and `halt` |
| `cycle/sweep.ts` | the whole search: `mergeFeeds`, `gatherCandidates` — three feeds in, one gated and scored list out |
| `cycle/scan.ts` | **the fetch**: `runScan` every 60s — feeds in, `store.pool` out. Also `syncLiveBalance` |
| `cycle/analyse.ts` | **the analyst queue**: `runAnalyst` — next token, ask, its exits, its entry, repeat |
| `cycle/entries.ts` | `openEntries` + `openPosition`: the only place that opens a position |
| `cycle/exits.ts` | every path out: `applyExits`, `closePosition`, `bookSell`, `withdrawExitPlan`, the daily loss budget. `bookSell` is the one post-sell path both `closePosition` and `reconcile` run through |
| `cycle/monitor.ts` | the 5s loop (`monitorSeconds`, a constant — not a dashboard input, and each tick costs one `tokenInfo`, weight 1, per open position): mirror the wallet (`reconcile`), then run the exit plan — and the same plan again on every streamed price in between. Never calls the model |
| `analyst.ts` | the model half: the prompt, the brief, `askAnalyst(candidates, slots, fresh)`, `extractJson`. One LLM call per batch, with the read-only tools on a per-call budget |
| `runtime.ts` | lifecycle: `start`, `stop`, `reschedule`, `scanNow`, `manualClose`. The whole surface `src/index.ts` drives |
| `calibrate.ts` | offline: re-prices those rows later and reports whether `score()` ranked anything. Reads only; never trades |

Data flow: every minute `gatherCandidates` (3 GMGN feeds, deduped) → `runGates` + `score` →
`store.pool` → `dueNow` → `askAnalyst(batch)` (`{entries, exits, recheck, notes}`) → `applyExits` →
`buyableSet` over that batch → `broker.buy/sell` → `store` mutation → `store.emit` → SSE →
`public/app.js`. The monitor loop runs independently and never touches the LLM.

**`gatherCandidates` is the whole search, and the brief is the near-whole evidence base.** The
analyst can deep-dive a row it was shown (12 lookups per call, none required), but it cannot
search: an address outside the brief never went through `toCandidate` or the gates, so there is
nothing to size and `buyableSet` refuses it. **No lookup is mandatory** — the operator removed
the kline-per-entry rule: the prompt says to decide from the brief when it is enough and to pull
a lookup only when the answer would change the decision or the exit plan. When one is spent,
`/v1/token/info` is much richer than the brief and carries most of what the feeds leave blank —
bundler and sniper concentration (`stat.top_bundler_trader_percentage`, `top70_sniper_hold_rate`),
`fresh_wallet_rate`, `bot_degen_rate`, dev status and deployer history (`dev.creator_token_status`,
`stat.creator_created_count`), `pool.initial_liquidity` against current, `ath_price`, and the
buy/sell *volume* split that neither feed reports. The tool's description in `src/agent/tools.ts`
is the field inventory, written from live responses — keep it that way, since it is the model's
only view of the route. What stays a stated blank is only what neither the brief nor those two
routes carries. The operator steers
the sweep through the dashboard's Feed filters panel
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
  **The Jupiter path (live Solana) does not check it — the operator's decision.** There the
  barrier is `SOLANA_PRIVATE_KEY` being present, plus `broker` refusing when that key's address
  is not the wallet selected on the dashboard. Don't extend that exemption to any other route.
- **The analyst's tools are five read routes and nothing else.** `askAnalyst` passes
  `budgetedTools(LOOKUP_BUDGET)` from `src/agent/tools.ts` — `gmgn_token_info`,
  `gmgn_token_kline`, `gmgn_token_traders` (the holder set wallet by wallet: cost basis,
  whether they are still in, and the wallet that funded them — bucket weight 5),
  `gmgn_token_holders` (the same row ranked by what is held now, so it adds the pool and
  wallets that were sent supply without buying — also weight 5) and `gmgn_market_signal`
  (GMGN's 50 latest alerts of one type on a chain, cut down to the populated fields; the only
  tool that takes no address, and a cross-check only — `buyableSet` still refuses anything
  outside the brief. Its bucket weight is unlisted in `ROUTE`, so it is charged 1, unverified),
  all `exist`-auth reads through `market/gmgn.ts`. The unattended loop still
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
  per-feed from the dashboard's **Feed filters** panel — but they disqualify nothing. Consequence to
  keep in mind when editing: a candidate with a $2k pool, no smart money and a dev still holding
  reaches `askAnalyst` looking like any other row, and only the analyst, the feed filters and
  `securityRisk` stand between it and a position. `SKIP` is gone entirely: `gatherCandidates`
  sends only the operator's Feed filters rows, so blank Feed filters fetch the feeds unfiltered. Don't
  reintroduce a structural gate — or a hardcoded feed floor — without asking: the dashboard is
  where that policy lives now.
- **A batch costs one LLM call plus at most `LOOKUP_BUDGET` (12) GMGN reads.** The budget is
  enforced in `budgetedTools`, not in the prompt: calls past it return a refusal string, so the
  model answers from the brief instead of erroring. `maxSteps` is `LOOKUP_BUDGET + 2`, and going
  over it throws — that batch is passed on. Raising the budget takes tokens straight out of the
  process-wide bucket (capacity 5, refilling 20 per 30s) that the fetch (8 weight a minute) and
  the monitor (12 a minute per open position) also run on; measure before you raise it.
- **In live mode the wallet, not the ledger, says what is still held.** The whole exit plan runs
  on GMGN's side, so positions shrink and disappear without this process selling anything — and
  the operator can sell from GMGN's UI too. One `walletHoldings` read per monitor tick (not per
  position) is the mirror; `reconcile` in `cycle/monitor.ts` books whatever left through
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
- **`buyableSet` is the last word on what can be bought.** It is handed the batch the analyst was
  shown. It re-checks gates, cooldown,
  blacklist and open positions in `cycle/entries.ts` immediately before entries — deliberately *after*
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
- **The sweep is three ranking feeds, 40 rows each, and nothing else.** `trending-1h`,
  `trending-5m` and `graduated` (trenches `completed`, Solana/BSC/Robinhood only). The signal
  route is no longer called: every alert type carries zero flow (`volume_*`, `swaps_*`, `buys_*`,
  `net_buy_*` are 0 on all of them, and `smart_degen_count` is 0 even on a smart-money buy), so a
  row only an alert surfaced had nothing to judge and a row it tagged kept the rank feed's numbers
  anyway — a label, not a source. `market/gmgn.ts` still wraps `signals`, and the analyst can
  pull it as a tool (`gmgn_market_signal`) — the sweep still does not; `git log` this file for
  the measured per-type overlap and the `trigger_mc` carry-across if it ever comes back.
- **Take-profit rungs sell a % of `originalQty`**, but a live percent sell is a % of the *current
  wallet balance* — `broker.sell` converts between the two. On the wire that percent becomes
  `input_amount_bps` (basis points: 50% → `"5000"`) and `input_amount` is a `"0"` placeholder.
- **`kline` takes milliseconds**; every other timestamp in `market/gmgn.ts` is seconds.
- **In live mode, sizing comes from the real wallet** (`syncLiveBalance` → `/v1/user/info`),
  not the paper bankroll. If the balance can't be read, entries are skipped for that cycle rather
  than sized off a guess — GMGN rate-limits `insufficient token balance` errors specifically.
- Per-chain floors exist for a reason: `MIN_POSITION_USD` (round-trip friction) and `GAS_RESERVE`
  (a fully deployed wallet must still be able to pay to exit).

## Frontend

`public/` is vanilla HTML/CSS/JS with no build step — `src/index.ts` serves the directory as-is and
`app.js` consumes `/api/stream` (SSE). Keep it dependency-free.

### Analyst skills (`skills/`, `src/agent/skills.ts`)

The analyst's system prompt opens with a general memecoin-trader persona (`systemPrompt` in
`analyst.ts`) — temperament only, no selection policy, so it never overrules the operator's box.
Skills are upgrades on top of it: every `skills/<name>/SKILL.md` is loaded fresh each cycle by
`loadSkills()` (alphabetical, empty or missing files skipped) and framed by `skillBlock()` —
after THE MACHINE, before OPERATOR INSTRUCTIONS, so a skill ranks under both. Adding a skill is
dropping a folder in; no code change. The cycle log line `Analyst: … · skills: …` says which
loaded. A skill is method, not policy: a limit you would want a skill to enforce belongs in
`domain/`, because nothing but the model reads a SKILL.md.

## Extending

- **More for the analyst to judge on**: add the field to the `brief` object in `askAnalyst`, from
  data the sweep already fetched. Not a tool — the analyst has none, and a new GMGN call per
  candidate is paid out of the sweep's rate limit.
- **New GMGN route**: add it to `OpenApiClient` in `src/gmgn/endpoint.ts` and wrap it in
  `market/gmgn.ts`, which is the cast boundary. Nothing above it speaks HTTP.
- **A tool, if it ever comes back**: `src/agent/tools.ts` is the empty template — shape,
  schema rules and the allowlist discipline are in its header.
- **New config knob**: `domain/types.ts` → `DEFAULT_CONFIG` → a clamp in `sanitizeConfig` → the UI.
