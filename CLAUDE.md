# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Runtime

Node 22+ running TypeScript directly (native type stripping) — no build step, no bundler,
**zero runtime dependencies**. `@types/node` is the only devDependency; `typescript` is a
peerDependency used for type-checking only.

This is deliberate: the code sticks to `fetch` + Node stdlib so it also runs under Bun and Deno.
Do not reach for Bun-specific APIs (`Bun.serve`, `bun:sqlite`, `Bun.file`, `Bun.$`), and do not
add npm dependencies without being asked.

## Commands

```bash
npm run dash                                  # dashboard + engine → http://127.0.0.1:3111
npm start                                     # legacy interactive CLI chat (has a bash tool)
npm test                                      # node --test, all *.test.ts
node --test trading.test.ts                   # one file
node --test --test-name-pattern="stop-loss"   # one test by name
npx tsc --noEmit                              # type check
```

`GMGN_API_KEY` is required — every market read is an HTTP call to the GMGN OpenAPI.
`GMGN_PRIVATE_KEY` (a request-signing key, not a wallet key) is only needed for live mode:
it signs `swap` and `query_order`, the two routes GMGN requires a signature on. There is no
`gmgn-cli` dependency; `gmgn-skills/` is an untracked reference clone of its source, kept only
to look up endpoint shapes and field semantics, and excluded from `tsconfig.json`.

**Tests are not fully hermetic.** `trading.test.ts` calls `engine.start()`, which schedules a real
scan 1.5s later; that scan hits the live GMGN API and writes `data/state.json` /
`data/config.json`. Expect network calls, a few seconds of runtime, and mutated `data/` (gitignored).
`gmgn.test.ts` is the exception — pure, no network. `npm test` loads `.env` so the key is present.

## Architecture

Two entry points share `agent.ts` + `skills.ts`:

- `server.ts` — the real product. Static file server + JSON control API + SSE stream, driving `trading/`.
- `index.ts` — older readline chat loop. Has a `bash` tool; unrelated to the trading engine.

`agent.ts` is a ~80-line OpenRouter tool-calling loop (`runAgent`): tools are
`{description, parameters (JSON Schema), run}`, it loops until the model replies without tool calls.

`skills.ts` implements progressive disclosure: only each skill's `name` + `description` go into
the system prompt (`skillIndex`); the full `SKILL.md` body is returned by the `load_skill` tool.
Skills live in `<root>/<name>/SKILL.md` with flat `key: value` frontmatter.

**There are two skill roots, and they are not interchangeable.** `skills/` holds the seven
vendored `gmgn-*` skills: they are written for an interactive assistant with a shell, they open
by telling the model to run `gmgn-cli config --check` and to ask the user for an API key, and
`index.ts` loads them — correctly, since it has a bash tool and a human at the prompt.
`trading/skills/` holds `scanning` and `analysis`, written for the headless analyst: they
describe `analystTools`, not shell commands, and there is no user in that loop to ask.
`engine.ts` loads only the latter. Don't point the engine at `skills/`.

### The central split (`trading/plan.ts` header states it; respect it)

**Gates, sizing, and exits are deterministic code. The model only ranks and writes theses.**
A position must never depend on an LLM call succeeding in order to be closed. The model can veto a
trade or request an early exit; it can never widen a risk limit. When adding features, keep new
risk logic in `plan.ts`/`config.ts` — not in prompts.

### `trading/` layering (import order, roughly)

| File | Role |
|---|---|
| `types.ts` | shared types, no logic |
| `config.ts` | defaults, per-chain constants, `sanitizeConfig` (every dashboard input is clamped here — these bounds are safety limits, not input tidying), `liveReady` |
| `store.ts` | **module-level singleton** `store`; reads `data/` on import, debounced atomic writes, pub/sub for SSE |
| `gmgn.ts` | GMGN OpenAPI client (`fetch`); all calls serialized through one promise queue + leaky bucket (GMGN adds 5s to the cooldown per 429, so retry spam makes it worse). Two auth modes: *exist* (API key) for every read, *signed* (API key + `X-Signature`) for `swap` and `query_order` only |
| `plan.ts` | pure functions: `toCandidate`, `runGates`, `score`, `positionSize`, `evaluateExit`, `healthExit`, prompts. No I/O — this is where tests concentrate |
| `broker.ts` | paper vs live execution of buy/sell; the only place that submits swaps |
| `engine.ts` | scan loop (interval minutes) + monitor loop (30s), analyst tool definitions, lifecycle |

Data flow per cycle: `gatherCandidates` (3 GMGN feeds, deduped) → `runGates` + `score` →
top 18 eligible → `askAnalyst` (LLM returns JSON `{entries, exits, notes}`) → `buyableSet` →
`broker.buy/sell` → `store` mutation → `store.emit` → SSE → `public/app.js`. The monitor loop runs
independently and never touches the LLM.

`gatherCandidates` is the **floor**, not the whole search. During `askAnalyst` the model can call
`find_tokens` (trending / trenches / signals / hot_searches) to look where the fixed sweep does not,
steered by the operator's dashboard prompt — that is the only way `cfg.prompt` reaches scanning,
since the sweep itself runs before the model is called. Rows it finds land in the module-level
`discovered` map, already gated. If the model calls nothing, or the call fails, the cycle degrades
to exactly the pre-scan behaviour.

## Invariants worth knowing before you edit

- **Never set `GMGN_ALLOW_AUTOMATED_TRADES` from code.** `gmgn.swap()` throws if it isn't already
  in the environment. That variable is the operator's standing consent to headless execution;
  the process is not entitled to grant it on their behalf. Same reasoning behind `liveReady()`.
  This process signs its own trade requests, so that check is now the *entire* barrier — there is
  no second process left to refuse on our behalf. Don't add a config knob that substitutes for it.
- **`analystTools` in `engine.ts` is read-only by design** — no bash tool, no swap tool. An analyst
  that cannot spend money cannot be talked into spending money by a token name. Keep new analyst
  tools read-only.
- **`securityRisk` is a pre-trade refusal, not a gate, and that is deliberate.** It runs once per
  entry in `openPosition` (paper and live alike) against `token_security`, because only that route
  answers reliably — `trenches` rows report `renounced_*: false` on tokens the security route
  reports as `true`, so gating on a feed row would kill the whole feed. Runs on every chain now:
  the tax half (`buy_tax`/`sell_tax` > 10%) applies everywhere, the mint/freeze and burn halves
  are Solana-only — those authorities do not exist on EVM and EVM liquidity is locked rather than
  burned. Fails closed on all chains, so EVM entries now cost one `token_security` call each.
  Measured on live candidates: the authority half never fires (launchpads revoke at creation),
  the burn half refuses about 1 in 14 otherwise-clean candidates.
- **`runGates` is a transcription of GMGN's 🔴 Skip column** (`skills/gmgn-market/SKILL.md`,
  "Pass / Watch / Skip Criteria") plus two data-integrity checks. Nothing in it is a number
  someone picked. The 🟡 Watch band passes on purpose — `score()` marks it down, the analyst
  rejects it. The thresholds live in the `SKIP` constant in `config.ts`, deliberately *not* in
  `TradeConfig` and not on the dashboard: `runGates(c)` takes no config, so there is no operator
  input to clamp and no way for a stored `data/config.json` to drift off the table. Tightening
  belongs in the dashboard prompt, where the analyst acts on it. Don't re-add a gate without a
  row to cite, and don't turn these back into knobs.
- **Discovery widens the search, never the risk envelope.** `find_tokens` clamps every threshold
  back up to `store.config` (asking for `min_liquidity_usd: 1` still returns nothing under
  `cfg.minLiquidityUsd`), runs `runGates` on every row before returning it, and `buyableSet` in
  `plan.ts` re-checks gates, cooldown, blacklist and open positions before an address can be bought.
  A token being in `discovered` is permission to be *considered*, not to be bought.
- **Token names/symbols are attacker-controlled data.** The system prompt says so; don't add code
  paths that treat scanned text as instructions.
- **GMGN percent conventions differ per field.** `rug_ratio` and `top_10_holder_rate` are ratios
  (0–1); `price_change_percent1h`/`5m` already arrive as percent. Mixing them silently breaks gates.
- **Take-profit rungs sell a % of `originalQty`**, but a live percent sell is a % of the *current
  wallet balance* — `broker.sell` converts between the two. On the wire that percent becomes
  `input_amount_bps` (basis points: 50% → `"5000"`) and `input_amount` is a `"0"` placeholder.
- **`kline` takes milliseconds**; every other timestamp in `gmgn.ts` is seconds.
- **In live mode, sizing comes from the real wallet** (`syncLiveBalance` → `/v1/user/info`),
  not the paper bankroll. If the balance can't be read, entries are skipped for that cycle rather
  than sized off a guess — GMGN rate-limits `insufficient token balance` errors specifically.
- Per-chain floors exist for a reason: `MIN_POSITION_USD` (round-trip friction) and `GAS_RESERVE`
  (a fully deployed wallet must still be able to pay to exit).

## Frontend

`public/` is vanilla HTML/CSS/JS with no build step — `server.ts` serves the directory as-is and
`app.js` consumes `/api/stream` (SSE). Keep it dependency-free.

## Extending

- **New analyst tool**: add an entry to `analystTools` in `trading/engine.ts` (`description`,
  `parameters`, `run`). Read-only.
- **New skill**: `trading/skills/<name>/SKILL.md` for the trading analyst, `skills/<name>/SKILL.md`
  for the interactive CLI — see the two-roots note above. `name` + `description` frontmatter;
  supporting files go in the same directory and `load_skill` hands the model the absolute path.
  A skill for the analyst must describe tools, never shell commands, and must never address a user.
- **New config knob**: `types.ts` → `DEFAULT_CONFIG` → a clamp in `sanitizeConfig` → the UI.
