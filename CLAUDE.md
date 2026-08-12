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
npm run cli                                   # legacy interactive CLI chat (has a bash tool)
npm test                                      # node --test, all *.test.ts
node --test src/trading/plan.test.ts          # one file
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

Two entry points share `src/agent/llm.ts` + `src/agent/skills.ts`:

- `src/index.ts` — the real product. Static file server + JSON control API + SSE stream, driving `src/trading/`.
- `src/cli.ts` — older readline chat loop. Has a `bash` tool; unrelated to the trading engine.

### Storage

Everything persisted lives in one SQLite file, `data/tta.db`, opened by `src/trading/db.ts`
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

`src/agent/llm.ts` is a ~80-line OpenRouter tool-calling loop (`runAgent`): tools are
`{description, parameters (JSON Schema), run}`, it loops until the model replies without tool calls.

`src/agent/skills.ts` implements progressive disclosure: only each skill's `name` + `description` go into
the system prompt (`skillIndex`); the full `SKILL.md` body is returned by the `load_skill` tool.
Skills live in `<root>/<name>/SKILL.md` with flat `key: value` frontmatter.

**There is one skill root: `skills/`,** loaded by both `src/cli.ts` and the trading analyst.
`token-analysis` is the procedure both use — it is written against the `gmgn_*` tool names and
closes with a section for the headless analyst. The seven vendored `gmgn-*` skills alongside it
are the original CLI ones: their data and thresholds are good, their `gmgn-cli` shell commands are
a second path to the same endpoints, and `token-analysis` opens with a table mapping one to the
other. There used to be a second root at `src/trading/skills/` (`scanning` + `analysis`) written
against a separate analyst tool set; both went when the analyst moved onto the shared tools.

### The central split (`src/trading/plan.ts` header states it; respect it)

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

### `src/trading/` layering (import order, roughly)

| File | Role |
|---|---|
| `types.ts` | shared types, no logic |
| `config.ts` | defaults, per-chain constants, `num`, `sanitizeConfig` (every dashboard input is clamped here — these bounds are safety limits, not input tidying), `liveReady`. Imports nothing but `types.ts` — keep it that way, it is what lets `plan.ts` stay I/O-free |
| `db.ts` | the one SQLite file (`data/tta.db`) via `node:sqlite`; schema, `kv` helpers, row writers, one-shot import of the pre-SQLite JSON files. `TTA_DB` overrides the path |
| `store.ts` | **module-level singleton** `store`; mutable state in `kv.state` (debounced), trades + equity as rows, pub/sub for SSE |
| `market.ts` | what the engine asks GMGN, in the engine's vocabulary: feeds, normalisation, prices, swap wrappers. The **cast boundary** — `OpenApiClient` returns `unknown`, nothing above this file speaks HTTP or touches `gmgnClient()` |
| `plan.ts` | pure functions: `toCandidate`, `runGates`, `score`, `positionSize`, `evaluateExit`, `healthExit`. No I/O, and importing it must not open the database or the API client — this is where tests concentrate |
| `broker.ts` | paper vs live execution of buy/sell; the only place that submits swaps |
| `analyst.ts` | the model half of a cycle: the read-only tool allowlist, the prompts (`systemPrompt`, `exitPlan`, `describeRule`), the cycle brief, `askAnalyst`, `extractJson`. Spends nothing |
| `engine.ts` | scan loop (interval minutes) + monitor loop (30s), entries and exits, lifecycle |
| `soundings.ts` | append-only table of every scanned candidate + its price at scan time; written by the scan, costs no API call |
| `calibrate.ts` | offline: re-prices those rows later and reports whether `score()` ranked anything. Reads only; never trades |

Data flow per cycle: `gatherCandidates` (3 GMGN feeds, deduped) → `runGates` + `score` →
top 18 eligible → `askAnalyst` (LLM returns JSON `{entries, exits, notes}`) → `buyableSet` →
`broker.buy/sell` → `store` mutation → `store.emit` → SSE → `public/app.js`. The monitor loop runs
independently and never touches the LLM.

**`gatherCandidates` is the whole search.** Only what the sweep surfaced can be bought: the
analyst has read-only tools and can research anything, but an address outside the brief never went
through `toCandidate` or the gates, so there is nothing to size and `buyableSet` refuses it. The
operator steers the sweep through the dashboard's Refine panel (`refineQuery`), not through the
prompt — `cfg.prompt` shapes selection, not fetching, because the sweep runs before the model is
called. The analyst used to have a `find_tokens` tool that widened the search mid-cycle; it and its
`discovered` plumbing were dropped once Refine covered the same ground from the dashboard.
`ANALYST_TOOL_NAMES` now carries no discovery feed at all — `gmgn_trending`, `gmgn_trenches`,
`gmgn_token_signal` and `gmgn_hot_searches` are out, leaving exactly the per-token routes
`skills/token-analysis` walks, and a test asserts they stay out. The analyst analyses the brief; it
does not re-sweep. Consequence: `sniper_count` lives only on a feed row, so it is now a stated
blank unless the brief carries it — `bundler_rate` and dev status survive as `stat.*` / `dev.*`
in `gmgn_token_info`.

## Invariants worth knowing before you edit

- **Never set `GMGN_ALLOW_AUTOMATED_TRADES` from code.** `OpenApiClient` throws on every route
  that spends — swap, multi-swap, strategy create, token create — if it isn't already in the
  environment. That variable is the operator's standing consent to headless execution;
  the process is not entitled to grant it on their behalf. Same reasoning behind `liveReady()`.
  This process signs its own trade requests, so that check is now the *entire* barrier — there is
  no second process left to refuse on our behalf. Don't add a config knob that substitutes for it.
- **The analyst's tool set is an allowlist, and that is the whole safety barrier.** It shares
  `src/agent/tools.ts` with the interactive CLI, which has `bash` and the spend routes. `analyst.ts`
  names the read-only tools it wants one by one in `ANALYST_TOOL_NAMES`, so a tool added to the
  shared file is *not* in the analyst's hands until someone adds its name — the safe default when
  that file grows is "no". A test in `plan.test.ts` asserts `bash` and the spend routes stay out;
  it fails the moment the allowlist grows something it should not have. Never invert it into a
  denylist: this loop runs unattended on rows named by whoever deployed the contract.
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
- **The analyst researches one candidate per cycle, and the tool wrapper enforces it.**
  `budgetedTools` in `analyst.ts` wraps every `gmgn_*` tool with a per-cycle budget:
  `RESEARCH_CANDIDATES = 1` distinct candidate address, `RESEARCH_CALLS = 12` calls total, skill
  loads free, open-position addresses exempt so an early exit can still be evidenced. Over budget
  returns a sentence, never a throw — a thrown error would end the cycle with no decision, a
  refusal the model can read just makes it decide from the brief. This exists because GMGN's
  bucket (20 tokens, 20/s, process-wide) is shared with the sweep and `token_top_holders` weighs
  5: an analyst walking all 18 shortlisted rows earns 429s whose 5s penalties outlive the cycle.
  The prompt states the same limit, but the prompt is not what enforces it.
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

- **New tool**: add it to `tools` in `src/agent/tools.ts` (`description`, `parameters`, `run`).
  The CLI picks it up immediately. To give it to the trading analyst as well, add its name to
  `ANALYST_TOOL_NAMES` in `src/trading/analyst.ts` — read-only only, and never `bash`.
  **Spell every query param out in `parameters`, with `enum` where the API has a fixed set.**
  There is no passthrough `extra` object any more: the schema is the model's only description of
  the route, and GMGN drops unknown keys silently, so a param it cannot see is one it cannot use
  and a param it guesses looks like a call that worked. The `min_*`/`max_*` filter surfaces come
  from the `bounds()` helper and the two tables above it; the vendored `skills/gmgn-*` docs are
  the reference for accepted values. A test asserts no tool reintroduces a free-form object.
- **New skill**: `skills/<name>/SKILL.md`, with `name` + `description` frontmatter. Only those two
  lines reach the system prompt; the body is returned by `load_skill`, which hands the model an
  absolute path, so supporting files can live in the same directory. Both entry points load this
  root, so a skill must work with or without a human at the prompt: describe tools, and don't ask
  the reader questions.
- **New config knob**: `types.ts` → `DEFAULT_CONFIG` → a clamp in `sanitizeConfig` → the UI.
