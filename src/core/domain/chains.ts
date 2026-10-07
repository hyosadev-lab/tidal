import type { Chain } from "./types.ts";

/**
 * Everything that differs per chain, and the fee arithmetic built on it. Numbers only — no
 * config, no I/O — so both the pure rules and the executor can read them without dragging
 * anything else in. The measured ones say where they were measured; keep it that way.
 */

export const CHAINS: Chain[] = ["sol", "bsc", "base", "eth", "robinhood"];

/** Native currency address + decimals per chain — copied from the gmgn-swap skill table. */
export const NATIVE: Record<Chain, { symbol: string; address: string; decimals: number }> = {
  sol: { symbol: "SOL", address: "So11111111111111111111111111111111111111112", decimals: 9 },
  bsc: { symbol: "BNB", address: "0x0000000000000000000000000000000000000000", decimals: 18 },
  base: { symbol: "ETH", address: "0x0000000000000000000000000000000000000000", decimals: 18 },
  eth: { symbol: "ETH", address: "0x0000000000000000000000000000000000000000", decimals: 18 },
  robinhood: { symbol: "ETH", address: "0x0000000000000000000000000000000000000000", decimals: 18 },
};

/**
 * Smallest position worth opening per chain. Driven by round-trip friction:
 * SOL gas is fractions of a cent, ETH mainnet gas is not.
 */
export const MIN_POSITION_USD: Record<Chain, number> = { sol: 3, bsc: 5, base: 5, eth: 25, robinhood: 5 };

/**
 * Cap on the simulated price impact of a paper fill when slippage is on auto. Live swaps ask
 * GMGN to pick per route; paper has no route to ask about, so it needs a number.
 */
export const AUTO_SLIPPAGE_CAP = 20;

/**
 * Fees in native units, sent only when a swap carries `condition_orders` — GMGN rejects that
 * combination unless both `priority_fee` and `tip_fee` (the MEV-protected relay's tip) are
 * present. Real-world knob: too low and the protected buy lands late on a busy block, too high
 * and it eats the edge. `GMGN_PRIORITY_FEE` / `GMGN_TIP_FEE` override for all chains.
 */
export const PRIORITY_FEE: Record<Chain, number> = { sol: 0.002, bsc: 0.0005, base: 0.00002, eth: 0.0005, robinhood: 0.0001 };
export const TIP_FEE: Record<Chain, number> = { sol: 0.001, bsc: 0.0002, base: 0.00001, eth: 0.0002, robinhood: 0.00005 };

/** Native units kept aside for gas. Without this, a full deployment cannot pay to exit. */
export const GAS_RESERVE: Record<Chain, number> = { sol: 0.02, bsc: 0.004, base: 0.0015, eth: 0.004, robinhood: 0.002 };

/**
 * ── What a swap costs, and what that implies ──────────────────────────
 *
 * Two halves, and only the first one scales: `SWAP_FEE_PCT` is a percentage of the trade (GMGN's
 * 1% routing fee plus the pool's own — ~1.2% on pump_amm), `TX_COST_NATIVE` is flat per
 * transaction (priority fee, MEV tip, account rent) whatever the trade is worth. 0.006 SOL is
 * ~$0.45: 0.2% of a $200 leg and 9% of a $5 one. That second half is why small positions and long
 * take-profit ladders lose money on their own, and it is invisible to any model expressed in
 * percentages — which is what this file's numbers used to be.
 *
 * The Solana figures are measured off `sol_cost` in a live `/v1/trade/quote`; the other chains
 * carry the priority + tip their own swaps send. Robinhood (an Arbitrum-Orbit L2, gas in ETH) is
 * not measured: 0.0003 ETH is ~200k gas at the ~1.4 gwei its `/v1/chain/gas_price` averaged.
 */
export const SWAP_FEE_PCT: Record<Chain, number> = { sol: 2.2, bsc: 1.3, base: 1.3, eth: 1.3, robinhood: 1.3 };
export const TX_COST_NATIVE: Record<Chain, number> = { sol: 0.006, bsc: 0.0007, base: 0.00003, eth: 0.0007, robinhood: 0.0003 };

/** A paper leg's two costs, applied to the USD crossing it: a percentage, then the flat tx fee. */
export const netOfFees = (chain: Chain, gross: number, nativeUsd: number): number =>
  Math.max(0, gross * (1 - SWAP_FEE_PCT[chain] / 100) - TX_COST_NATIVE[chain] * nativeUsd);

/**
 * How far a position has to rise from its entry price before selling it returns what it cost —
 * the hurdle every exit rule is measured against. Pass `costUsd` once the buy has settled for the
 * real figure; without it the entry leg is estimated from the same constants.
 *
 * Nothing below this line is profit-taking, whatever the rule is called: a take-profit at +5% on
 * a 9% hurdle is a loss with a friendly name.
 */
export function breakevenPct(chain: Chain, valueUsd: number, nativeUsd: number, costUsd?: number): number {
  if (!(valueUsd > 0)) return 0;
  const fee = SWAP_FEE_PCT[chain] / 100;
  const tx = TX_COST_NATIVE[chain] * nativeUsd;
  const paid = costUsd && costUsd > 0 ? costUsd : valueUsd * (1 + fee) + tx;
  return ((paid + tx) / (1 - fee) / valueUsd - 1) * 100;
}
