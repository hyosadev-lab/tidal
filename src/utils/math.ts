// SOL constants
export const LAMPORTS_PER_SOL = 1_000_000_000;
export const SOL_ADDRESS = 'So11111111111111111111111111111111111111112';
export const CHAIN = 'sol';
export const GMGN_HOST = 'https://openapi.gmgn.ai';

// Convert SOL to lamports string (for GMGN input_amount)
export function solToLamports(sol: number): string {
  return Math.floor(sol * LAMPORTS_PER_SOL).toString();
}

// Convert lamports string to SOL
export function lamportsToSol(lamports: string, decimals: number = 9): number {
  return Number(lamports) / Math.pow(10, decimals);
}

// Compute PnL percentage
export function computePnlPct(entryPrice: number, currentPrice: number): number {
  if (entryPrice === 0) return 0;
  return ((currentPrice - entryPrice) / entryPrice) * 100;
}

// Compute PnL in USD
export function computePnlUsd(
  solInvested: number,
  solPriceUsd: number,
  pnlPct: number
): number {
  return solInvested * solPriceUsd * (pnlPct / 100);
}

// Average of an array of numbers
export function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

// Minutes elapsed since a unix timestamp (seconds)
export function minutesSince(unixSeconds: number): number {
  return (Date.now() / 1000 - unixSeconds) / 60;
}

export function unixMillis(): number {
  return Date.now();
}

export function unixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// Format USD for display
export function formatUsd(amount: number): string {
  const sign = amount >= 0 ? '+' : '';
  return `${sign}$${amount.toFixed(2)}`;
}

// Format percentage for display
export function formatPct(pct: number): string {
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

// Solscan tx URL
export function solscanTx(hash: string): string {
  return `https://solscan.io/tx/${hash}`;
}
