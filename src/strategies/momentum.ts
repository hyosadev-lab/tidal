import { type KlineCandle, type TokenInfo } from '../services/gmgn-client.ts';
import { avg } from '../utils/math.ts';

export interface MomentumSignal {
  score: number;
  // Komponen 1: volume surge ratio (volume_5m vs rata-rata 5m dalam 1 jam)
  surgRatio: number;
  // Komponen 2: buy dominance (buy_volume_5m / volume_5m)
  buyDominance: number;
  // Komponen 3: volume acceleration dari kline (last 3 vs prior 3)
  volumeAcceleration: number;
  // Komponen 4: price change % dalam 5m + green candle pattern
  priceMomentum5m: number;
  greenCandlePct: number;
  // Komponen 5: swap intensity
  swaps5m: number;
}

export function scoreMomentum(
  candles: KlineCandle[],
  priceInfo: TokenInfo["price"],
): MomentumSignal {
  const volume5m  = parseFloat(priceInfo.volume_5m);
  const volume1h  = parseFloat(priceInfo.volume_1h);
  const buyVolume5m = parseFloat(priceInfo.buy_volume_5m);
  const currentPrice = parseFloat(priceInfo.price);
  const price5mAgo   = parseFloat(priceInfo.price_5m);

  // ── Komponen 1: Volume Surge Ratio ───────────────────────────────────────
  // Bandingkan volume_5m dengan rata-rata per-5m dalam 1 jam (volume_1h / 12)
  const avgVolPer5m = volume1h > 0 ? volume1h / 12 : 0;
  const surgeRatio  = avgVolPer5m > 0 ? volume5m / avgVolPer5m : 0;

  // ── Komponen 2: Buy Dominance ─────────────────────────────────────────────
  // Menggantikan buyPressureRatio yang sebelumnya overlap dengan surge
  const buyDominance = volume5m > 0 ? buyVolume5m / volume5m : 0.5;

  // ── Komponen 3, 4: dari kline ─────────────────────────────────────────────
  let volumeAcceleration = 0;
  let greenCandlePct     = 0;
  let priceMomentum5m    = 0;

  if (candles.length >= 6) {
    // Volume acceleration: last 3 vs prior 3 candles
    const last3  = candles.slice(-3);
    const prior3 = candles.slice(-6, -3);
    const last3AvgVol  = avg(last3.map((c) => parseFloat(c.volume)));
    const prior3AvgVol = avg(prior3.map((c) => parseFloat(c.volume)));
    volumeAcceleration = prior3AvgVol > 0 ? last3AvgVol / prior3AvgVol : 0;

    // Candle color pattern: last 8 candles
    const recentCandles = candles.slice(-8);
    const greenCount = recentCandles.filter(
      (c) => parseFloat(c.close) > parseFloat(c.open)
    ).length;
    greenCandlePct = (greenCount / recentCandles.length) * 100;

    // Price momentum: % change dalam 5m
    priceMomentum5m = price5mAgo > 0
      ? ((currentPrice - price5mAgo) / price5mAgo) * 100
      : 0;
  }

  // ── Scoring ───────────────────────────────────────────────────────────────
  let score = 0;

  // 1. Volume Surge Ratio — max 35 pts
  // Seberapa besar lonjakan volume 5m vs rata-rata 5m dalam 1 jam
  if (surgeRatio >= 4.0)      score += 35;
  else if (surgeRatio >= 2.5) score += 25;
  else if (surgeRatio >= 1.6) score += 14;
  // < 1.6 → tidak ada surge signifikan → +0

  // 2. Volume Acceleration (kline-based) — max 25 pts
  // Komplementer dengan surge: konfirmasi dari candle data
  if (volumeAcceleration >= 2.0)       score += 25;
  else if (volumeAcceleration >= 1.5)  score += 18;
  else if (volumeAcceleration >= 1.25) score += 11;
  else if (volumeAcceleration >= 1.1)  score += 5;

  // 3. Price Momentum + Green Candle (kombinasi) — max 20 pts
  // +20% price change dalam 5m = priceMomentumNorm 1.0 (penuh)
  const priceMomentumNorm = priceMomentum5m > 0
    ? Math.min(priceMomentum5m / 20, 1.0)
    : 0;
  const priceGreenScore = priceMomentumNorm * 0.6 + (greenCandlePct / 100) * 0.4;
  score += Math.round(priceGreenScore * 20);

  // 4. Buy Dominance — max 15 pts
  // Menggantikan buyPressureRatio lama, bobot lebih kecil karena sudah
  // tercermin sebagian di surge ratio
  if (buyDominance >= 0.68)      score += 15;
  else if (buyDominance >= 0.58) score += 10;
  else if (buyDominance >= 0.50) score += 5;
  // < 0.50 → sellers dominan → +0

  // 5. Swap Intensity — max 5 pts
  if (priceInfo.swaps_5m >= 100)     score += 5;
  else if (priceInfo.swaps_5m >= 60) score += 3;

  // Bonus synergy: surge kuat + buyers dominan bersamaan
  if (surgeRatio >= 2.5 && buyDominance >= 0.60 && volumeAcceleration >= 1.3) {
    score += 5;
  }

  return {
    score: Math.min(Math.max(score, 0), 100),
    surgRatio: surgeRatio,
    buyDominance,
    volumeAcceleration,
    priceMomentum5m,
    greenCandlePct,
    swaps5m: priceInfo.swaps_5m,
  };
}
