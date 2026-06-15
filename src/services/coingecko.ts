// SOL price cache — refreshed every 5 minutes
let cachedSolPriceUsd = 150; // fallback default
let solPriceLastFetched = 0;
const SOL_PRICE_TTL_MS = 5 * 60 * 1000;

const COINGECKO_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd";

export async function getSolPriceUsd(): Promise<number> {
  if (Date.now() - solPriceLastFetched < SOL_PRICE_TTL_MS) {
    return cachedSolPriceUsd;
  }

  try {
    const res = await fetch(COINGECKO_URL);
    const data = (await res.json()) as any;
    cachedSolPriceUsd = data?.solana?.usd ?? cachedSolPriceUsd;
    solPriceLastFetched = Date.now();
  } catch {
    // use cached value silently
  }

  return cachedSolPriceUsd;
}
