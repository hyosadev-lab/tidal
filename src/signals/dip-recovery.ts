import { type KlineCandle, type TokenInfo } from '../services/gmgn-client.ts';

// Sweet spot dip range — sesuai komentar di interface (55-75%), BUKAN 50-90
// seperti versi lama di strategies/. Range dipersempit supaya lebih selektif.
const SWEET_SPOT_MIN = 55;
const SWEET_SPOT_MAX = 75;
const SWEET_SPOT_CENTER = 65;
const HARD_MIN_DIP = 40; // di bawah ini dianggap belum cukup dip untuk strategi ini
const HARD_MAX_DIP = 92; // di atas ini terlalu dalam — kemungkinan token sekarat, bukan dip

export interface DipRecoverySignal {
  score: number;                    // 0-100

  // Depth
  athPrice: number;
  dipFromAthPct: number;
  isInSweetSpot: boolean;           // 55-75%

  // Trend
  hasLowerLow: boolean;             // downtrend masih berlanjut
  isDowntrendSlowing: boolean;

  // Buyer Strength
  buyVolumeRatio5m: number;
  buyTxRatio5m: number;
  buyerDominance: number;           // gabungan volume + tx

  // Bounce Quality
  hasRejectionWick: boolean;
  recentBouncePct: number;          // % naik dari recent low

  // Risk
  isDeadCatBounce: boolean;         // spike ekstrem setelah dip
}

function zeroSignal(overrides: Partial<DipRecoverySignal> = {}): DipRecoverySignal {
  return {
    score: 0,
    athPrice: 0,
    dipFromAthPct: 0,
    isInSweetSpot: false,
    hasLowerLow: false,
    isDowntrendSlowing: false,
    buyVolumeRatio5m: 0,
    buyTxRatio5m: 0,
    buyerDominance: 0,
    hasRejectionWick: false,
    recentBouncePct: 0,
    isDeadCatBounce: false,
    ...overrides,
  };
}

/**
 * @param candles   - kline candle terbaru (resolusi & window ditentukan caller,
 *                    dipakai untuk trend/wick/bounce/dead-cat detection)
 * @param tokenInfo - snapshot token_info; sumber athPrice & 5m buy/sell stats
 */
export function scoreDipRecovery(
  candles: KlineCandle[],
  tokenInfo: TokenInfo,
): DipRecoverySignal {
  const athPrice = tokenInfo.ath_price;
  const currentPrice = parseFloat(tokenInfo.price.price);
  const buyVolume5m = parseFloat(tokenInfo.price.buy_volume_5m);
  const sellVolume5m = parseFloat(tokenInfo.price.sell_volume_5m);
  const buys5m = tokenInfo.price.buys_5m;
  const sells5m = tokenInfo.price.sells_5m;

  if (candles.length === 0 || athPrice <= 0) {
    return zeroSignal({ athPrice });
  }

  // ── Depth: dip dari ATH ────────────────────────────────────────────────
  const dipFromAthPct = ((athPrice - currentPrice) / athPrice) * 100;
  const isInSweetSpot = dipFromAthPct >= SWEET_SPOT_MIN && dipFromAthPct <= SWEET_SPOT_MAX;

  if (dipFromAthPct < HARD_MIN_DIP) {
    // Belum cukup dip — token masih dekat ATH, bukan target strategi ini
    return zeroSignal({ athPrice, dipFromAthPct });
  }
  if (dipFromAthPct > HARD_MAX_DIP) {
    // Dip ekstrem — kemungkinan besar rug/dead token, bukan recovery play
    return zeroSignal({ athPrice, dipFromAthPct, score: 10 });
  }

  // ── Risk: dead cat bounce — spike >100% di 3 candle terakhir ───────────
  const recentCandles = candles.slice(-3);
  const isDeadCatBounce = recentCandles.some((c) => {
    const open = parseFloat(c.open);
    const close = parseFloat(c.close);
    if (open === 0) return false;
    return (close - open) / open > 1.0;
  });

  if (isDeadCatBounce) {
    return zeroSignal({ athPrice, dipFromAthPct, isInSweetSpot, isDeadCatBounce });
  }

  // ── Trend: lower low check — 3 candle terakhir vs 3 sebelumnya ─────────
  const windowSize = 3;
  const lastN = candles.slice(-windowSize);
  const prevN = candles.slice(-(windowSize * 2), -windowSize);

  const lastLow = Math.min(...lastN.map((c) => parseFloat(c.low)));
  const prevLow = prevN.length > 0 ? Math.min(...prevN.map((c) => parseFloat(c.low))) : lastLow;

  const hasLowerLow = prevN.length > 0 && lastLow < prevLow;
  const isDowntrendSlowing = !hasLowerLow;

  // ── Bounce Quality: rejection wick pada candle terendah ─────────────────
  // Rejection wick = lower wick panjang relatif ke body, candle close di atas
  // separuh range-nya — menandakan seller ditolak di harga rendah.
  const lowestCandle = candles.reduce((min, c) =>
    parseFloat(c.low) < parseFloat(min.low) ? c : min
  , candles[0]!);
  const hasRejectionWick = (() => {
    const open = parseFloat(lowestCandle.open);
    const close = parseFloat(lowestCandle.close);
    const high = parseFloat(lowestCandle.high);
    const low = parseFloat(lowestCandle.low);
    const range = high - low;
    if (range <= 0) return false;
    const bodyTop = Math.max(open, close);
    const lowerWick = bodyTop - low > 0 ? Math.min(open, close) - low : 0;
    const closePosition = (close - low) / range; // 0 = close di low, 1 = close di high
    return lowerWick / range > 0.4 && closePosition > 0.5;
  })();

  // ── Bounce Quality: % naik dari recent low ke harga sekarang ────────────
  const recentLow = Math.min(...candles.map((c) => parseFloat(c.low)));
  const recentBouncePct = recentLow > 0 ? ((currentPrice - recentLow) / recentLow) * 100 : 0;

  // ── Buyer Strength ────────────────────────────────────────────────────
  const totalVolume5m = buyVolume5m + sellVolume5m;
  const buyVolumeRatio5m = totalVolume5m > 0 ? buyVolume5m / totalVolume5m : 0.5;

  const totalTx5m = buys5m + sells5m;
  const buyTxRatio5m = totalTx5m > 0 ? buys5m / totalTx5m : 0.5;

  // [Menebak] buyerDominance = weighted mix volume (60%) + tx count (40%) —
  // volume dianggap lebih informatif karena tahan terhadap wash-trade kecil
  // berulang yang bisa menginflate tx count tanpa dollar value signifikan.
  const buyerDominance = buyVolumeRatio5m * 0.6 + buyTxRatio5m * 0.4;

  // Hard gate: tanpa buyer dominance minimal, ini falling knife bukan recovery
  if (buyVolumeRatio5m < 0.50) {
    return zeroSignal({
      athPrice,
      dipFromAthPct,
      isInSweetSpot,
      hasLowerLow,
      isDowntrendSlowing,
      buyVolumeRatio5m,
      buyTxRatio5m,
      buyerDominance,
      hasRejectionWick,
      recentBouncePct,
    });
  }

  // ── Scoring ──────────────────────────────────────────────────────────
  let score = 0;

  // 1. Depth — distance dari sweet spot center (65%) — max 30 pts
  const distance = Math.abs(dipFromAthPct - SWEET_SPOT_CENTER);
  const maxDistance = Math.max(SWEET_SPOT_CENTER - HARD_MIN_DIP, HARD_MAX_DIP - SWEET_SPOT_CENTER);
  score += Math.round(30 * (1 - distance / maxDistance));

  // 2. Trend — downtrend slowing — max 15 pts
  if (isDowntrendSlowing) score += 15;

  // 3. Buyer Strength — buyerDominance gabungan — max 30 pts
  if (buyerDominance >= 0.65)      score += 30;
  else if (buyerDominance >= 0.58) score += 20;
  else if (buyerDominance >= 0.50) score += 8;

  // 4. Bounce Quality — rejection wick + recent bounce — max 25 pts
  if (hasRejectionWick) score += 12;
  if (recentBouncePct > 15)      score += 13;
  else if (recentBouncePct > 5)  score += 6;

  return {
    score: Math.max(0, Math.min(score, 100)),
    athPrice,
    dipFromAthPct,
    isInSweetSpot,
    hasLowerLow,
    isDowntrendSlowing,
    buyVolumeRatio5m,
    buyTxRatio5m,
    buyerDominance,
    hasRejectionWick,
    recentBouncePct,
    isDeadCatBounce,
  };
}
