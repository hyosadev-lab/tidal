---
name: scanning
description: How to choose and parameterise the find_tokens feeds — which feed answers which kind of operator instruction, what each one is blind to, and the exact vocabulary for intervals, launchpad platforms, token age and signal types. Load this before searching for tokens the pre-scan did not surface.
---

# Choosing where to look

Every cycle already gives you a pre-scan: `trending` at 1h and 5m, plus launchpad graduates
on sol and bsc. That sweep is fixed — it runs before you are called and it does not read the
operator's instructions. `find_tokens` is the only way those instructions reach the search.

Do not call it out of habit. Call it when the operator points somewhere the sweep does not
look, or when the candidate list is thin and you have budget left.

| Feed | Answers | Blind to |
|---|---|---|
| `trending` | "what is actually trading right now", ranked by volume | anything too new or too small to rank |
| `trenches` | "what just graduated from a launchpad" | established tokens; rows are microcaps and most fail the liquidity gate |
| `signals` | "what just did something notable" — smart money bought, price spiked, new ATH | slow accumulation with no trigger event |
| `hot_searches` | "what are people looking up" — crowd attention before price | quality of any kind; this is attention, not conviction |

`trending` is the workhorse. The other three are for when the operator asks for something it
structurally cannot answer.

## Translating instructions into calls

- *"new pump.fun launches"* → `trenches` with `trench_type: "new_creation"`, or `trending`
  with `platforms: ["Pump.fun"]` and `max_age: "6h"`. The second is usually better: trenches
  rows are pre-liquidity and nearly all fail the gates.
- *"what graduated recently"* → `trenches`, `trench_type: "completed"`.
- *"follow the smart money"* → `signals` with `signal_types: [12]`.
- *"what's breaking out"* → `signals` with `signal_types: [6, 7]`.
- *"what's getting attention"* → `hot_searches`.
- *"only established, liquid names"* → `trending` with `min_liquidity_usd` and `min_age: "24h"`.

If the instruction names a corner none of these reach, say so in `notes` rather than
substituting a feed that answers a different question.

## Parameter vocabulary

**interval** (`trending`, `hot_searches`): `1m`, `5m`, `1h`, `6h`, `24h`. Short intervals
surface momentum; long ones surface staying power.

**min_age / max_age** (`trending` only): a number with a unit suffix — `30m`, `6h`, `7d`.
A bare number is rejected.

**signal_types** (`signals` only): `12` smart money buy · `6` price spike · `7` all-time high ·
`14` large buy · `15` multiple buys · `16` multiple large buys · `20` KOL buy · `11` community
takeover · `10` bundler sell (a warning, not an entry). Omit to get smart-money buys plus
spikes and ATHs.

**trench_type**: `new_creation` (still on the bonding curve) · `near_completion` (curve nearly
full) · `completed` (graduated to a DEX).

**platforms** (`trending` only), by chain:
- sol — `Pump.fun`, `letsbonk`, `bags`, `believe`, `boop`, `heaven`, `moonshot_app`,
  `jup_studio`, `ray_launchpad`, `meteora_virtual_curve`
- bsc — `fourmeme`, `flap`, `clanker`, `likwid`, `openfour`, `lunafun`
- base — `clanker`, `flaunch`, `zora`, `bankr`
- eth — `clanker`, `trench`, `printr`

## What the tool will not do for you

Every threshold you pass is clamped back up to the operator's configured floors. Asking for
`min_liquidity_usd: 1` does not return thinner tokens — it returns the same set as asking for
the configured minimum. There is no parameter that loosens a gate, and there is no point
looking for one.

Rows come back with `gate_failures` already filled in. A row carrying failures cannot be
bought; naming it in `entries` wastes the slot and gets logged as a miss. Read `blocked` too —
`already held`, `on cooldown`, `blacklisted` mean the same thing in practice.

Two or three calls with different parameters beats one broad call. Each one costs a step out
of the same budget you need for `token_detail` and `top_holders`, so spend them on questions
the pre-scan genuinely cannot answer.
