import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AUTO_SLIPPAGE_CAP,
  breakevenPct,
  DEFAULT_CONFIG,
  gasReserve,
  minLegUsd,
  netOfFees,
  liveReady,
  minPosition,
  refineQuery,
  sanitizeConfig,
  slippage,
} from "./config.ts";
import {
  buyableSet,
  entryStrategy,
  evaluateExit,
  healthExit,
  positionSize,
  gateTally,
  runGates,
  score,
  securityRisk,
  toCandidate,
  viableStrategy,
} from "./plan.ts";
import { isDust } from "./plan.ts";
import { extractJson } from "../analyst.ts";
import { trenchesFilters } from "../exec/market.ts";
import { bands, median, spearman } from "../calibrate.ts";
import { conditionOrders, recordExternalSell } from "../exec/broker.ts";
import { candidate, position } from "./fixtures.ts";
import type { Candidate, StrategyRule, TradeConfig } from "./types.ts";

// Pure: no network, no engine, no shared store. Everything stateful or live lives in
// engine.test.ts. This is where the trading plan's own rules are pinned.

const cfg: TradeConfig = { ...DEFAULT_CONFIG };

// ── pre-trade security refusal ────────────────────────────────────────

const safeSec = { renounced_mint: true, renounced_freeze_account: true, burn_status: "burn", burn_ratio: 1 };

test("a renounced Solana token with burned liquidity clears the check", () => {
  assert.equal(securityRisk(safeSec, "sol"), "");
  // GMGN sends 1 on some routes and true on others; both mean renounced.
  assert.equal(securityRisk({ ...safeSec, renounced_mint: 1, renounced_freeze_account: 1 }, "sol"), "");
});

test("a live mint or freeze authority is named, not merely flagged", () => {
  assert.match(securityRisk({ ...safeSec, renounced_mint: false }, "sol"), /mint authority/);
  assert.match(securityRisk({ ...safeSec, renounced_freeze_account: false }, "sol"), /freeze authority/);
  const both = securityRisk({ ...safeSec, renounced_mint: 0, renounced_freeze_account: 0 }, "sol");
  assert.match(both, /mint authority/);
  assert.match(both, /freeze authority/);
});

test("unburned liquidity blocks entry — the deployer can still pull the pool", () => {
  assert.match(securityRisk({ ...safeSec, burn_status: "none", burn_ratio: 0 }, "sol"), /not burned/);
  assert.match(securityRisk({ ...safeSec, burn_status: "", burn_ratio: 0 }, "sol"), /not burned/);
});

test("either burn field alone is enough to prove the pool was burned", () => {
  assert.equal(securityRisk({ ...safeSec, burn_status: "burn", burn_ratio: 0 }, "sol"), "");
  assert.equal(securityRisk({ ...safeSec, burn_status: "", burn_ratio: 1 }, "sol"), "");
});

test("an unreadable or silent security response fails closed rather than passing", () => {
  assert.notEqual(securityRisk(null, "sol"), "");
  assert.notEqual(securityRisk({}, "sol"), "");
  // Renounce answered, burn not — still a refusal, not a partial pass.
  assert.match(securityRisk({ renounced_mint: true, renounced_freeze_account: true }, "sol"), /burn status unknown/);
});

test("the renounce and burn halves do not apply on EVM, where neither means the same thing", () => {
  for (const chain of ["bsc", "base", "eth"]) {
    assert.equal(securityRisk({ renounced_mint: false, burn_status: "none" }, chain), "");
  }
});

// Tax is the one half that applies everywhere — it lives here rather than in runGates because
// only token_security answers it reliably. Threshold is GMGN's own 🔴 band (>0.10).
test("a tax above 10% is refused on every chain", () => {
  for (const chain of ["sol", "bsc", "base", "eth"]) {
    assert.match(securityRisk({ ...safeSec, sell_tax: 0.4 }, chain), /tax 40% > 10%/);
    assert.match(securityRisk({ ...safeSec, buy_tax: 0.11 }, chain), /tax 11% > 10%/);
    // At the threshold, and absent entirely, both pass. Solana carries no tax fields at all.
    assert.equal(securityRisk({ ...safeSec, buy_tax: 0.1, sell_tax: 0.1 }, chain), "");
  }
});

test("an unreadable response fails closed on EVM too, not just Solana", () => {
  assert.notEqual(securityRisk(null, "bsc"), "");
});

// ── what the analyst is allowed to buy ────────────────────────────────

const at = (addr: string, over: Partial<Candidate> = {}) => candidate({ address: addr, ...over });

test("a swept candidate is buyable once it clears the gates, keyed lowercased", () => {
  const set = buyableSet([at("SweptAddr")], new Set());
  assert.deepEqual([...set.keys()], ["sweptaddr"]);
});

test("a candidate that failed a gate is never buyable", () => {
  const set = buyableSet([at("RuggyAddr", { gateFailures: ["wash trading"] })], new Set());
  assert.equal(set.size, 0);
});

test("cooldown, blacklist and open positions block an otherwise clean candidate", () => {
  const set = buyableSet([at("BlockedAddr")], new Set(["blockedaddr"]));
  assert.equal(set.size, 0);
});

test("the first row wins when the sweep surfaced the same token twice", () => {
  const set = buyableSet([at("SameAddr", { symbol: "FIRST" }), at("sameaddr", { symbol: "SECOND" })], new Set());
  assert.equal(set.size, 1);
  assert.equal(set.get("sameaddr")?.symbol, "FIRST");
});

test("a candidate with no address cannot slip into the buyable set", () => {
  assert.equal(buyableSet([at("")], new Set()).size, 0);
});

// ── gates ─────────────────────────────────────────────────────────────

test("a clean candidate passes every gate", () => {
  assert.deepEqual(runGates(candidate()), []);
});

test("honeypots and wash trading are rejected outright", () => {
  assert.ok(runGates(candidate({ isHoneypot: true })).includes("honeypot"));
  assert.ok(runGates(candidate({ isWashTrading: true })).includes("wash trading"));
});

// Structure no longer disqualifies. Every one of these was a gate failure before; each is now
// the analyst's call, marked down by score() and filterable from the Refine panel, not refused.
test("structure is scored, not gated", () => {
  assert.deepEqual(runGates(candidate({ devHolding: true })), []);
  assert.deepEqual(runGates(candidate({ rugRatio: 0.9 })), []);
  assert.deepEqual(runGates(candidate({ top10HolderRate: 0.95 })), []);
  assert.deepEqual(runGates(candidate({ liquidityUsd: 200 })), []);
  assert.deepEqual(runGates(candidate({ smartDegenCount: 0 })), []);
  // The worst of all of them at once still only fails on what is left.
  assert.deepEqual(
    runGates(candidate({ devHolding: true, rugRatio: 0.9, top10HolderRate: 0.95, liquidityUsd: 200, smartDegenCount: 0 })),
    [],
  );
  // ...but it should score far below a clean one, since that is now the only thing marking it.
  assert.ok(score(candidate({ rugRatio: 0.9, top10HolderRate: 0.95, liquidityUsd: 200, smartDegenCount: 0 })) < score(candidate()));
});

test("thin volume, a young token and a huge mcap still pass", () => {
  assert.deepEqual(runGates(candidate({ volume1hUsd: 0, ageMinutes: 1, marketCapUsd: 100_000_000 })), []);
});

test("the gate tally counts every failure, busiest first", () => {
  const swept = [
    candidate({ isWashTrading: true }),
    candidate({ isWashTrading: true }),
    candidate({ isWashTrading: true, isHoneypot: true }),
    candidate(),
  ].map((c) => ({ ...c, gateFailures: runGates(c) }));

  // Three wash failures, one honeypot — and the token that failed both is counted in each.
  assert.equal(gateTally(swept), "wash 3 · honeypot 1");
  assert.equal(gateTally([candidate()].map((c) => ({ ...c, gateFailures: runGates(c) }))), "");
});

test("data integrity is still a gate", () => {
  assert.ok(runGates(candidate({ address: "" })).includes("no address"));
  assert.ok(runGates(candidate({ priceUsd: 0 })).includes("no price"));
});

// ── scoring ───────────────────────────────────────────────────────────

test("smart money lifts the score", () => {
  assert.ok(score(candidate({ smartDegenCount: 6 })) > score(candidate({ smartDegenCount: 0 })));
});

test("an already-extended move scores below a measured one", () => {
  assert.ok(score(candidate({ change1hPct: 600 })) < score(candidate({ change1hPct: 60 })));
});

test("deeper liquidity scores higher", () => {
  assert.ok(score(candidate({ liquidityUsd: 500_000 })) > score(candidate({ liquidityUsd: 31_000 })));
});

// ── sizing ────────────────────────────────────────────────────────────

test("size respects the risk budget and never spends the last of the cash", () => {
  const full = positionSize(cfg, 1000, 1000, 100);
  assert.ok(full <= 1000 * (cfg.riskPerTradePct / 100) + 0.001);
  assert.ok(positionSize(cfg, 1000, 20, 100) <= 18);
});

test("higher conviction sizes larger", () => {
  assert.ok(positionSize(cfg, 1000, 1000, 100) > positionSize(cfg, 1000, 1000, 0));
});

// ── exits ─────────────────────────────────────────────────────────────

test("stop-loss fires at the configured drawdown and exits in full", () => {
  const e = evaluateExit(position({ lastPrice: 0.00074 }), cfg);
  assert.equal(e?.percent, 100);
  assert.equal(e?.kind, "stop");
});

test("a position inside the envelope produces no exit", () => {
  assert.equal(evaluateExit(position({ lastPrice: 0.0011 }), cfg), null);
});

test("take-profit fills the highest rung a spike reaches", () => {
  const e = evaluateExit(position({ lastPrice: 0.005, peakPrice: 0.005 }), cfg); // +400%
  assert.equal(e?.kind, "tp2");
  assert.equal(e?.percent, 20);
});

test("a filled rung is not sold twice", () => {
  const p = position({ lastPrice: 0.0016, peakPrice: 0.0016, filledRungs: [0] }); // +60%
  assert.equal(evaluateExit(p, cfg), null);
});

test("the trailing stop arms above the threshold and fires on giveback", () => {
  const p = position({ lastPrice: 0.00146, peakPrice: 0.00146, filledRungs: [0] }); // +46%, arms
  assert.equal(evaluateExit(p, cfg), null);
  assert.equal(p.trailArmed, true);
  p.lastPrice = 0.00105; // ~28% off the peak, still green
  const e = evaluateExit(p, cfg);
  assert.equal(e?.kind, "trail");
  assert.equal(e?.percent, 100);
});

test("the time stop closes dead money but spares a winner", () => {
  const old = Date.now() - (cfg.timeStopMinutes + 10) * 60_000;
  assert.equal(evaluateExit(position({ openedAt: old, lastPrice: 0.00101 }), cfg)?.kind, "time");
  assert.equal(evaluateExit(position({ openedAt: old, lastPrice: 0.00109 }), cfg), null);
});

// ── rule-set exits (Fixed trading strategy / the analyst's own plan) ──

const RULES: StrategyRule[] = [
  { kind: "sl", at: -30, sell: 100 },
  { kind: "tp", at: 60, sell: 40 },
  { kind: "tp", at: 400, sell: 20 },
  { kind: "ttp", at: 100, dd: 25, sell: 50 },
];

test("a position with rules ignores the config stop and ladder", () => {
  // -26%: past the config's -25% stop, inside the rule set's -30% one.
  assert.equal(evaluateExit(position({ strategy: RULES, lastPrice: 0.00074 }), cfg), null);
  const e = evaluateExit(position({ strategy: RULES, lastPrice: 0.0006 }), cfg);
  assert.equal(e?.kind, "rule0");
  assert.equal(e?.percent, 100);
});

test("the highest take-profit rule a spike reaches wins", () => {
  const e = evaluateExit(position({ strategy: RULES, lastPrice: 0.005, peakPrice: 0.005 }), cfg);
  assert.equal(e?.kind, "rule2");
  assert.equal(e?.percent, 20);
});

test("a trailing take-profit rule needs both the arm and the giveback", () => {
  // Peak +150% so the ttp is armed, but only 10% off it. The +60% rung is already filled.
  const held = { strategy: RULES, peakPrice: 0.0025, filledRungs: [1] };
  assert.equal(evaluateExit(position({ ...held, lastPrice: 0.00225 }), cfg), null);
  const e = evaluateExit(position({ ...held, lastPrice: 0.0018 }), cfg);
  assert.equal(e?.kind, "rule3");
  assert.equal(e?.percent, 50);
});

test("a trailing stop tighter than the stop loss does not shadow it on the way down", () => {
  // The shape the analyst keeps writing: a -30% stop plus a 15% trail. Live from entry the
  // trail would fire first on any drop and the stop could never be reached.
  const rules: StrategyRule[] = [
    { kind: "sl", at: -30, sell: 100 },
    { kind: "tsl", dd: 15, sell: 100 },
  ];
  // -15%: a full 15% off the peak, but underwater — the stop owns this half of the range.
  assert.equal(evaluateExit(position({ strategy: rules, lastPrice: 0.00085 }), cfg), null);
  assert.equal(evaluateExit(position({ strategy: rules, lastPrice: 0.00069 }), cfg)?.kind, "rule0");
  // +100% then 15% back off the peak: in profit, so the trail is the one that fires.
  const won = position({ strategy: rules, peakPrice: 0.002, lastPrice: 0.0017 });
  assert.equal(evaluateExit(won, cfg)?.kind, "rule1");
});

test("the stop loss wins a tick a trailing rule listed above it also triggers on", () => {
  // Memecoins gap between two 30s polls, so one tick can satisfy both rules. Order in the
  // list must not decide it: a `ttp` first would sell its own 50% down here and leave the
  // other half to the stop a tick later, which is how a stop stops mattering.
  const rules: StrategyRule[] = [
    { kind: "ttp", at: 20, dd: 60, sell: 50 },
    { kind: "sl", at: -30, sell: 100 },
  ];
  // Peaked at +30% (arming the ttp), now -50%: past the stop, and 62% off the peak.
  const gapped = position({ strategy: rules, peakPrice: 0.0013, lastPrice: 0.0005 });
  const e = evaluateExit(gapped, cfg);
  assert.equal(e?.kind, "rule1", "the stop, not the ttp written above it");
  assert.equal(e?.percent, 100);
});

test("a trailing take-profit does not fire underwater either", () => {
  // Same guard the tsl has: armed at +140%, 60% off the peak, but the position is at -5%.
  // Above the stop, so the answer is to wait for the stop — not to book a loss as a "profit".
  const rules: StrategyRule[] = [
    { kind: "ttp", at: 20, dd: 60, sell: 50 },
    { kind: "sl", at: -30, sell: 100 },
  ];
  assert.equal(evaluateExit(position({ strategy: rules, peakPrice: 0.0024, lastPrice: 0.00095 }), cfg), null);
  // Still in profit at +8% after the same giveback: now it is genuinely profit protection.
  const inProfit = position({ strategy: rules, peakPrice: 0.0027, lastPrice: 0.00108 });
  assert.equal(evaluateExit(inProfit, cfg)?.kind, "rule0");
});

test("a filled rule is not sold twice", () => {
  const p = position({ strategy: RULES, lastPrice: 0.0016, peakPrice: 0.0016, filledRungs: [1] });
  assert.equal(evaluateExit(p, cfg), null);
});

test("the time stop still applies to a rule set", () => {
  const old = Date.now() - (cfg.timeStopMinutes + 10) * 60_000;
  assert.equal(evaluateExit(position({ strategy: RULES, openedAt: old, lastPrice: 0.00101 }), cfg)?.kind, "time");
});

test("the model may shape the exit plan but not outrun the stop", () => {
  const dyn = { ...cfg, fixedStrategy: false, stopLossPct: 25 };
  const out = entryStrategy(dyn, [
    { kind: "sl", at: -80, sell: 100 },
    { kind: "tp", at: 90, sell: 60 },
  ]);
  assert.deepEqual(out[0], { kind: "sl", at: -25, sell: 100 });
  assert.equal(out.length, 2);
});

test("a plan with no stop gets one, and an unusable plan falls back to the config", () => {
  const dyn = { ...cfg, fixedStrategy: false };
  const added = entryStrategy(dyn, [{ kind: "tp", at: 90, sell: 100 }]);
  assert.equal(added.length, 2);
  assert.deepEqual(added[1], { kind: "sl", at: -cfg.stopLossPct, sell: 100 });
  // Nothing salvageable → no rules → evaluateExit uses the config stop/ladder/trail.
  assert.deepEqual(entryStrategy(dyn, [{ kind: "please sell", at: 5 }]), []);
  assert.deepEqual(entryStrategy(dyn, "sell everything"), []);
});

test("fixed mode ignores whatever the model proposes", () => {
  const fixed = { ...cfg, fixedStrategy: true, strategy: [{ kind: "tp" as const, at: 50, sell: 100 }] };
  const out = entryStrategy(fixed, [{ kind: "tp", at: 999, sell: 1 }]);
  assert.deepEqual(out, [
    { kind: "tp", at: 50, sell: 100 },
    { kind: "sl", at: -cfg.stopLossPct, sell: 100 },
  ]);
});

test("drained liquidity forces an exit", () => {
  const e = healthExit(position(), { liquidity: 20_000 }, 80_000);
  assert.equal(e?.percent, 100);
  assert.equal(healthExit(position(), { liquidity: 79_000 }, 80_000), null);
});

// ── config safety ─────────────────────────────────────────────────────

test("0 is the auto flag on the three fields that have one, not a real value", () => {
  const c = sanitizeConfig({ slippagePct: 0, minPositionUsd: 0, gasReserveNative: 0 });
  assert.equal(c.slippagePct, 0);
  // Auto still has to produce a usable number for a paper fill and for sizing.
  assert.equal(slippage(c), AUTO_SLIPPAGE_CAP);
  assert.equal(minPosition(c), 3);
  assert.equal(gasReserve(c), 0.02);
  // A real value is kept, and an out-of-range one is clamped rather than read as auto.
  assert.equal(sanitizeConfig({ slippagePct: 5 }).slippagePct, 5);
  assert.equal(sanitizeConfig({ slippagePct: 900 }).slippagePct, 100);
  assert.equal(sanitizeConfig({ slippagePct: -3 }).slippagePct, 0);
});

test("out-of-range config is clamped rather than trusted", () => {
  const c = sanitizeConfig({ riskPerTradePct: 900, intervalMinutes: 0, stopLossPct: -5, maxOpenPositions: 999 });
  assert.equal(c.riskPerTradePct, 50);
  assert.equal(c.intervalMinutes, 1);
  assert.equal(c.stopLossPct, 5);
  assert.equal(c.maxOpenPositions, 20);
});

test("refine rows survive as query params, blanks and junk do not", () => {
  const c = sanitizeConfig({
    refine: { ageMin: 5, top10Max: 40, devHoldingMax: 0, insiderMax: 900, feeMin: -1, kolMax: "" as never, nonsense: 3 } as never,
  });
  assert.deepEqual(c.refine, { ageMin: 5, top10Max: 40, devHoldingMax: 0, insiderMax: 100, feeMin: 0 });
  assert.deepEqual(refineQuery(c.refine), {
    min_created: "5m",
    max_top10_holder_rate: 0.4,
    max_dev_team_hold_rate: 0,
    max_insider_rate: 1,
    min_gas_fee: 0,
  });
  // Same rows, the names /v1/trenches uses for them.
  assert.deepEqual(refineQuery(c.refine, "trenches"), {
    min_created: "5m",
    max_top_holder_rate: 0.4,
    max_creator_balance_rate: 0,
    max_insider_ratio: 1,
    min_total_fee: 0,
  });
});

test("a refine row can tighten the trenches preset but never loosen it", () => {
  const loose = trenchesFilters({ max_insider_ratio: 0.9, min_smart_degen_count: 0 });
  assert.equal(loose.max_insider_ratio, 0.3);
  assert.equal(loose.min_smart_degen_count, 1);

  const tight = trenchesFilters({ max_insider_ratio: 0.05, min_smart_degen_count: 4, min_created: "5m" });
  assert.equal(tight.max_insider_ratio, 0.05);
  assert.equal(tight.min_smart_degen_count, 4);
  assert.equal(tight.min_created, "5m");
  // Untouched preset fields still ship.
  assert.equal(tight.max_rug_ratio, 0.3);
});

test("an unknown chain falls back instead of reaching the CLI", () => {
  assert.equal(sanitizeConfig({ chain: "; rm -rf /" as never }).chain, DEFAULT_CONFIG.chain);
});

test("live mode stays disarmed without the operator's opt-in", () => {
  const saved = process.env.GMGN_ALLOW_AUTOMATED_TRADES;
  delete process.env.GMGN_ALLOW_AUTOMATED_TRADES;
  assert.equal(liveReady({ ...cfg, walletAddress: "abc" }).ok, false);
  process.env.GMGN_ALLOW_AUTOMATED_TRADES = "1";
  assert.equal(liveReady({ ...cfg, walletAddress: "" }).ok, false, "wallet is still required");
  assert.equal(liveReady({ ...cfg, walletAddress: "abc" }).ok, true);
  if (saved === undefined) delete process.env.GMGN_ALLOW_AUTOMATED_TRADES;
  else process.env.GMGN_ALLOW_AUTOMATED_TRADES = saved;
});

// ── model output parsing ──────────────────────────────────────────────

test("a decision is recovered from a fenced, chatty reply", () => {
  const d = extractJson(
    'Here you go:\n```json\n{"entries":[{"address":"abc","conviction":72,"thesis":"x"}],"exits":[],"notes":"quiet"}\n```\nHope that helps.',
  );
  assert.equal(d?.entries.length, 1);
  assert.equal(d?.notes, "quiet");
});

test("garbage in the model reply yields no decision rather than a bad one", () => {
  assert.equal(extractJson("no json here at all"), null);
});

test("a rank row maps onto a candidate", () => {
  const c = toCandidate(
    {
      address: "abc",
      symbol: "WIF",
      price: "0.5",
      liquidity: "120000",
      volume: "50000",
      smart_degen_count: 3,
      rug_ratio: 0.04,
      top_10_holder_rate: 0.15,
      creator_token_status: "creator_close",
      price_change_percent1h: 42,
      creation_timestamp: Math.floor(Date.now() / 1000) - 3600,
    },
    "trending",
  );
  assert.equal(c.symbol, "WIF");
  assert.equal(c.liquidityUsd, 120_000);
  assert.equal(c.devHolding, false);
  assert.ok(Math.abs(c.change1hPct - 42) < 0.01, "percent passed through, not rescaled");
  assert.ok(c.ageMinutes > 55 && c.ageMinutes < 65);
});

// Live field names, checked against both feeds. The rank feed carries per-minute change and
// gas_fee but no net buy and no insider rate; trenches is the mirror image, under its own
// names. Whichever half is missing must arrive as null: a rate of 0 is a claim ("no insiders
// here"), and reading a blank as that claim is the expensive mistake available here.
test("feed-specific fields map by name, and what a feed omits stays null", () => {
  const rank = toCandidate(
    {
      address: "abc",
      price: 1,
      price_change_percent1m: 7.1,
      buys: 51_309,
      sells: 48_171,
      dev_team_hold_rate: 0.198,
      bundler_rate: 0.84,
      gas_fee: 279.4,
    },
    "trending",
  );
  assert.equal(rank.change1mPct, 7.1);
  assert.deepEqual([rank.buys, rank.sells], [51_309, 48_171]);
  assert.equal(rank.devHoldRate, 0.198);
  assert.equal(rank.bundlerRate, 0.84);
  assert.equal(rank.feeUsd, 279.4);
  assert.equal(rank.netBuyUsd, null, "the rank feed has no net buy — not a net buy of zero");
  assert.equal(rank.insiderRate, null, "nor an insider rate");

  const trench = toCandidate(
    {
      address: "def",
      price: 1,
      buys_24h: 1990,
      sells_24h: 2040,
      net_buy_24h: 4460.57,
      suspected_insider_hold_rate: 0.02,
      bundler_trader_amount_rate: 0.2179,
      total_fee: 7.08,
    },
    "graduated",
  );
  assert.deepEqual([trench.buys, trench.sells], [1990, 2040]);
  assert.equal(trench.netBuyUsd, 4460.57);
  assert.equal(trench.insiderRate, 0.02);
  assert.equal(trench.bundlerRate, 0.2179, "trenches names the bundler rate differently");
  assert.equal(trench.feeUsd, 7.08);
  assert.equal(trench.change1mPct, null, "trenches carries no price change at all");

  // An empty string is how GMGN sends "not measured" on some rows; it is not a zero either.
  assert.equal(toCandidate({ address: "x", price: 1, gas_fee: "" }, "t").feeUsd, null);
  assert.equal(toCandidate({ address: "x", price: 1, dev_team_hold_rate: 0 }, "t").devHoldRate, 0, "a real zero survives");
});

// The 5m feed sends the same column names as the 1h one, measured over five minutes — one row
// only ever carries one window, so `toCandidate` reads it into the unsuffixed fields and the
// sweep is what copies it across onto the hourly row. Anything that changes that mapping
// silently turns the brief's acceleration reading into an hour compared against itself.
test("a 5m feed row lands in the unsuffixed fields, and the 5m ones stay blank", () => {
  const row = { address: "abc", price: 1, buys: 206, sells: 117, volume: 11_802 };
  const c = toCandidate(row, "trending-5m");
  assert.deepEqual([c.buys, c.sells, c.volume1hUsd], [206, 117, 11_802]);
  assert.deepEqual(
    [c.buys5m, c.sells5m, c.volume5mUsd],
    [null, null, null],
    "a row cannot fill its own second window — gatherCandidates copies these onto the 1h row",
  );
});

// ── minimum position size ─────────────────────────────────────────────

test("the position floor tracks the chain's round-trip cost", () => {
  assert.equal(minPosition({ ...cfg, chain: "sol", minPositionUsd: 0 }), 3);
  assert.equal(minPosition({ ...cfg, chain: "eth", minPositionUsd: 0 }), 25);
  assert.equal(minPosition({ ...cfg, chain: "sol", minPositionUsd: 10 }), 10, "an explicit value wins");
});

test("gas is held back so a fully deployed wallet can still pay to exit", () => {
  assert.ok(gasReserve({ ...cfg, chain: "sol", gasReserveNative: 0 }) > 0);
  assert.equal(gasReserve({ ...cfg, chain: "sol", gasReserveNative: 0.05 }), 0.05);
});

// ── score calibration statistics ──────────────────────────────────────
// The report is only worth acting on if the maths under it is right — a sign error here
// would argue for inverting a weight that is fine.

test("spearman ranks monotonically, ignores scale, and survives ties", () => {
  const xs = [1, 2, 3, 4, 5];
  assert.equal(spearman(xs, [10, 20, 30, 40, 50]), 1);
  assert.equal(spearman(xs, [50, 40, 30, 20, 10]), -1);
  // Rank correlation, not Pearson: one huge outlier must not decide the answer.
  assert.equal(spearman(xs, [1, 2, 3, 4, 900]), 1);
  assert.equal(spearman(xs, [7, 7, 7, 7, 7]), 0, "a constant column correlates with nothing");
  assert.equal(spearman([1, 2], [1, 2]), 0, "too few rows to claim anything");
  assert.ok(Math.abs(spearman([1, 1, 2, 2, 3], [1, 2, 2, 3, 3])) < 1, "tied ranks are averaged");
});

test("bands bucket by score and describe what each bucket returned", () => {
  const rows = [
    { score: 5, ret: -0.5 },
    { score: 19, ret: -0.1 },
    { score: 20, ret: 0.1 },
    { score: 85, ret: 0.3 },
    { score: 95, ret: 1.0 },
  ];
  const b = bands(rows);
  assert.deepEqual(b.map((x) => x.n), [2, 1, 0, 0, 2], "edges are half-open: 19 is low, 20 is not");
  assert.equal(b[0]!.median, -0.3);
  assert.equal(b[0]!.winRate, 0);
  assert.equal(b[4]!.winRate, 1);
  assert.equal(b[4]!.bigWinRate, 1, "both cleared +20%");
  assert.equal(median([]), 0, "no rows is 0, not NaN");
});

test("an exit booked from the wallet prices the slice at the last seen price", () => {
  const p = position({ qty: 100_000, originalQty: 100_000, costUsd: 100, lastPrice: 0.0008 });
  const r = recordExternalSell(DEFAULT_CONFIG, p, 40_000, "gmgn stop");
  assert.ok(!("error" in r));
  if ("error" in r) return;
  assert.equal(r.proceeds, 32, "40k at $0.0008");
  assert.equal(r.trade.side, "sell");
  assert.equal(r.trade.pnlUsd, -8, "cost basis of the slice is $40");
  assert.equal(r.trade.pnlPct, -20);
});

test("the whole exit plan travels to GMGN, trailing rules included", () => {
  const rules: StrategyRule[] = [
    { kind: "tp", at: 35, sell: 40 },
    { kind: "ttp", at: 20, dd: 15, sell: 60 },
    { kind: "sl", at: -18, sell: 100 },
  ];
  const orders = conditionOrders(DEFAULT_CONFIG, rules, 25);
  assert.deepEqual(orders, [
    { order_type: "profit_stop", side: "sell", price_scale: "35", sell_ratio: "40" },
    { order_type: "profit_stop_trace", side: "sell", price_scale: "20", drawdown_rate: "15", sell_ratio: "60" },
    { order_type: "loss_stop", side: "sell", price_scale: "18", sell_ratio: "100" },
  ]);
});

test("a plan without a stop gets one, and no rules falls back to the config ladder", () => {
  const noStop = conditionOrders(DEFAULT_CONFIG, [{ kind: "tsl", dd: 12, sell: 100 }], 25);
  assert.deepEqual(noStop.at(0), { order_type: "loss_stop_trace", side: "sell", drawdown_rate: "12", sell_ratio: "100" });
  assert.equal(noStop.at(-1)?.order_type, "loss_stop", "the floor is appended when the plan omits it");
  assert.equal(noStop.at(-1)?.price_scale, "25");

  const legacy = conditionOrders(DEFAULT_CONFIG, [], 25);
  assert.equal(legacy.filter((o) => o.order_type === "profit_stop").length, DEFAULT_CONFIG.takeProfit.length);
  assert.equal(legacy.filter((o) => o.order_type === "profit_stop_trace").length, 1, "the config trail travels too");
  assert.equal(legacy.filter((o) => o.order_type === "loss_stop").length, 1);
});

test("a paper leg pays a percentage and a flat chain fee, so small legs cost more", () => {
  const SOL = 75; // $/SOL, roughly what the quote route reported when these numbers were measured.
  // $200 crossing one leg: 2.2% routing + pool, plus 0.006 SOL of chain fees.
  assert.equal(netOfFees("sol", 200, SOL).toFixed(2), (200 * 0.978 - 0.45).toFixed(2));

  const cost = (gross: number) => (1 - netOfFees("sol", gross, SOL) / gross) * 100;
  assert.ok(cost(200) < 2.5, "the flat fee disappears into a big leg");
  assert.ok(cost(5) > 10, "and eats a small one — this is the whole reason a $5 rung loses money");
  assert.equal(netOfFees("sol", 0.3, SOL), 0, "a leg worth less than its own fee nets nothing");
});

test("break-even is the round trip, and the flat fee makes it worse the smaller the position", () => {
  const SOL = 75;
  const big = breakevenPct("sol", 500, SOL);
  const small = breakevenPct("sol", 20, SOL);
  assert.ok(big > 4 && big < 6, `a $500 position clears on the percentage half alone, got ${big}`);
  assert.ok(small > 8, `a $20 one has to carry $0.90 of chain fees too, got ${small}`);
  // Measured against the live quote in the same units: $20 in, $20.65 out of the wallet.
  assert.ok(Math.abs(breakevenPct("sol", 20, SOL, 20.65) - 7.9) < 0.5);
});

test("the exit plan is repriced to what the fees allow", () => {
  const minLeg = minLegUsd("sol", 75); // $9
  // A target under the hurdle is lifted to it; a ttp's arm is lifted by its own giveback, since
  // peak × (1 - dd) is where it actually sells.
  const lifted = viableStrategy([{ kind: "tp", at: 5, sell: 100 }], 9, minLeg, 500);
  assert.deepEqual(lifted, [{ kind: "tp", at: 9, sell: 100 }]);
  const [ttp] = viableStrategy([{ kind: "ttp", at: 20, dd: 12, sell: 100 }], 9, minLeg, 500);
  assert.equal(ttp?.at, 23.9, "arming at +20 and giving back 12 would have sold at +5.6");

  // A $20 position cannot afford a rung that nets $6.40 — it folds into the one above it.
  const merged = viableStrategy(
    [{ kind: "tp", at: 60, sell: 20 }, { kind: "tp", at: 150, sell: 30 }, { kind: "sl", at: -25, sell: 100 }],
    9,
    minLeg,
    20,
  );
  assert.deepEqual(merged, [{ kind: "tp", at: 150, sell: 50 }, { kind: "sl", at: -25, sell: 100 }]);

  // When no rung is big enough the ladder collapses to the single leg it could afford.
  const collapsed = viableStrategy([{ kind: "tp", at: 20, sell: 10 }, { kind: "tp", at: 30, sell: 10 }], 9, minLeg, 20);
  assert.deepEqual(collapsed, [{ kind: "tp", at: 30, sell: 20 }]);

  // The same plan on a position ten times the size keeps every rung it was written with.
  const kept = viableStrategy([{ kind: "tp", at: 60, sell: 20 }, { kind: "tp", at: 150, sell: 30 }], 9, minLeg, 200);
  assert.equal(kept.length, 2);
});

test("a trailing rule cannot fire below break-even, where it would book a loss", () => {
  const rules: StrategyRule[] = [{ kind: "tsl", dd: 10, sell: 100 }];
  // +5% on the price, 12.5% off the peak — the giveback is reached, the round trip is not.
  const p = position({ strategy: rules, peakPrice: 0.0012, lastPrice: 0.00105, breakevenPct: 9 });
  assert.equal(evaluateExit(p, DEFAULT_CONFIG), null);
  assert.match(
    evaluateExit(position({ ...p, breakevenPct: 0 }), DEFAULT_CONFIG)?.reason ?? "",
    /trailing stop loss/,
    "the same tick on a position with no fees to clear is a real trail",
  );
});

test("dust: a remainder under $1 or under 2% of the buy closes the position", () => {
  assert.equal(isDust(position()), false);
  // 1.5% of the original quantity left — a rounding remainder from a 100% fill.
  assert.equal(isDust(position({ qty: 1_500 })), true);
  // 10% of the quantity left, but the price collapsed: under $1 is not worth another sell.
  assert.equal(isDust(position({ qty: 10_000, lastPrice: 0.00005 })), true);
  assert.equal(isDust(position({ qty: 10_000 })), false, "a real partial exit stays open");
});
