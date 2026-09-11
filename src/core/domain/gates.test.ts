import { test } from "node:test";
import assert from "node:assert/strict";
import { buyableSet } from "./candidates.ts";
import { candidate } from "./fixtures.ts";
import { gateTally, runGates, score, securityRisk } from "./gates.ts";
import type { Candidate } from "./types.ts";

// What refuses a row and what ranks the rest. Pure: no network, no store.

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
  for (const chain of ["bsc", "base", "eth", "robinhood"]) {
    assert.equal(securityRisk({ renounced_mint: false, burn_status: "none" }, chain), "");
  }
});

// Tax is the one half that applies everywhere — it lives here rather than in runGates because
// only token_security answers it reliably. Threshold is GMGN's own 🔴 band (>0.10).
test("a tax above 10% is refused on every chain", () => {
  for (const chain of ["sol", "bsc", "base", "eth", "robinhood"]) {
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
