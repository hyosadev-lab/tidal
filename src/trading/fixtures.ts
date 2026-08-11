import type { Candidate, Position } from "./types.ts";

/** Test fixtures. Nothing in the product imports this — `*.test.ts` files do. */

export function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    address: "So11111111111111111111111111111111111111112",
    symbol: "TEST",
    name: "Test",
    priceUsd: 0.001,
    marketCapUsd: 1_000_000,
    liquidityUsd: 80_000,
    volume1hUsd: 120_000,
    change5mPct: 4,
    change1hPct: 35,
    swaps1h: 500,
    holderCount: 900,
    smartDegenCount: 4,
    renownedCount: 1,
    rugRatio: 0.05,
    top10HolderRate: 0.18,
    devHolding: false,
    isWashTrading: false,
    isHoneypot: false,
    ageMinutes: 300,
    launchpad: "Pump.fun",
    source: "test",
    gateFailures: [],
    score: 0,
    ...over,
  };
}

export function position(over: Partial<Position> = {}): Position {
  return {
    id: "p1",
    chain: "sol",
    address: candidate().address,
    symbol: "TEST",
    openedAt: Date.now(),
    costUsd: 100,
    qty: 100_000,
    originalQty: 100_000,
    entryPrice: 0.001,
    lastPrice: 0.001,
    peakPrice: 0.001,
    realisedUsd: 0,
    filledRungs: [],
    trailArmed: false,
    thesis: "test",
    conviction: 70,
    stopLossPct: 25,
    entryLiquidityUsd: 80_000,
    ...over,
  };
}
