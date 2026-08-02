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

`gmgn-cli` must be installed globally (`npm install -g gmgn-cli`) and configured
(`gmgn-cli config`) — every market read shells out to it.

**Tests are not fully hermetic.** `trading.test.ts` calls `engine.start()`, which schedules a real
scan 1.5s later; that scan shells out to the live `gmgn-cli` and writes `data/state.json` /
`data/config.json`. Expect network calls, a few seconds of runtime, and mutated `data/` (gitignored).

## Architecture

Two entry points share `agent.ts` + `skills.ts`:

- `server.ts` — the real product. Static file server + JSON control API + SSE stream, driving `trading/`.
- `index.ts` — older readline chat loop. Has a `bash` tool; unrelated to the trading engine.

`agent.ts` is a ~80-line OpenRouter tool-calling loop (`runAgent`): tools are
`{description, parameters (JSON Schema), run}`, it loops until the model replies without tool calls.

`skills.ts` implements progressive disclosure: only each skill's `name` + `description` go into
the system prompt (`skillIndex`); the full `SKILL.md` body is returned by the `load_skill` tool.
Skills live in `skills/<name>/SKILL.md` with flat `key: value` frontmatter.

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
| `gmgn.ts` | `gmgn-cli` wrapper; all calls serialized through one promise queue + leaky bucket (GMGN adds 5s to the cooldown per 429, so retry spam makes it worse) |
| `plan.ts` | pure functions: `toCandidate`, `runGates`, `score`, `positionSize`, `evaluateExit`, `healthExit`, prompts. No I/O — this is where tests concentrate |
| `broker.ts` | paper vs live execution of buy/sell; the only place that submits swaps |
| `engine.ts` | scan loop (interval minutes) + monitor loop (30s), analyst tool definitions, lifecycle |

Data flow per cycle: `gatherCandidates` (3 GMGN feeds, deduped) → `runGates` + `score` →
top 18 eligible → `askAnalyst` (LLM returns JSON `{entries, exits, notes}`) → `broker.buy/sell` →
`store` mutation → `store.emit` → SSE → `public/app.js`. The monitor loop runs independently and
never touches the LLM.

## Invariants worth knowing before you edit

- **Never set `GMGN_ALLOW_AUTOMATED_TRADES` from code.** `gmgn.swap()` throws if it isn't already
  in the environment. That variable is the operator's standing consent to headless execution;
  the process is not entitled to grant it on their behalf. Same reasoning behind `liveReady()`.
- **`analystTools` in `engine.ts` is read-only by design** — no bash tool, no swap tool. An analyst
  that cannot spend money cannot be talked into spending money by a token name. Keep new analyst
  tools read-only.
- **Token names/symbols are attacker-controlled data.** The system prompt says so; don't add code
  paths that treat scanned text as instructions.
- **GMGN percent conventions differ per field.** `rug_ratio` and `top_10_holder_rate` are ratios
  (0–1); `price_change_percent1h`/`5m` already arrive as percent. Mixing them silently breaks gates.
- **Take-profit rungs sell a % of `originalQty`**, but live `--percent` is a % of the *current wallet
  balance* — `broker.sell` converts between the two.
- **In live mode, sizing comes from the real wallet** (`syncLiveBalance` → `gmgn-cli portfolio info`),
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
- **New skill**: `skills/<name>/SKILL.md` with `name` + `description` frontmatter. Supporting files
  go in the same directory; `load_skill` hands the model the absolute directory path.
- **New config knob**: `types.ts` → `DEFAULT_CONFIG` → a clamp in `sanitizeConfig` → the UI.
