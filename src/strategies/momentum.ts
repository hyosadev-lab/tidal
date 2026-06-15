import { type KlineCandle, type TokenInfo } from '../services/gmgn-client.ts';
import { avg } from '../utils/math.ts';

export interface MomentumSignal {
  score: number;
  // Komponen 1: buy pressure saat ini (5m window dari token_info)
  buyPressureRatio5m: number;
  // Komponen 2: volume acceleration dari kline
  volumeAcceleration: number;
  // Komponen 3: candle color pattern dari kline (last 8 candles)
  greenCandlePct: number;
  // Komponen 4: price change % dalam 5m
  priceMomentum5m: number;
  swaps5m: number;
}

export function scoreMomentum(
  candles: KlineCandle[],
  priceInfo: TokenInfo["price"],
): MomentumSignal {
  const volume5m = parseFloat(priceInfo.volume_5m);
  const buyVolume5m = parseFloat(priceInfo.buy_volume_5m);
  const currentPrice = parseFloat(priceInfo.price);
  const price5mAgo = parseFloat(priceInfo.price_5m);

  // ── Komponen 1: Buy pressure saat ini (5m) ───────────────────────────────
  const buyPressureRatio5m = volume5m > 0 ? buyVolume5m / volume5m : 0.5;

  // ── Komponen 2, 3, 4: dari kline + price info ─────────────────────────────
  let volumeAcceleration = 0;
  let greenCandlePct = 0;
  let priceMomentum5m = 0;

  if (candles.length >= 6) {
    // Volume acceleration: last 3 vs prior 3 candles
    const last3 = candles.slice(-3);
    const prior3 = candles.slice(-6, -3);
    const last3AvgVol = avg(last3.map((c) => parseFloat(c.volume)));
    const prior3AvgVol = avg(prior3.map((c) => parseFloat(c.volume)));
    volumeAcceleration = prior3AvgVol > 0 ? last3AvgVol / prior3AvgVol : 0;

    // Candle color pattern: last 8 candles (lebih representatif dari 6)
    const recentCandles = candles.slice(-8);
    const greenCount = recentCandles.filter(
      (c) => parseFloat(c.close) > parseFloat(c.open)
    ).length;
    greenCandlePct = (greenCount / recentCandles.length) * 100;

    // Price momentum: % change dalam 5m (price_5m adalah harga absolut awal window)
    priceMomentum5m = price5mAgo > 0
      ? ((currentPrice - price5mAgo) / price5mAgo) * 100
      : 0;
  }

  // ── Scoring ──────────────────────────────────────────────────────────────
  let score = 0;

  // 1. Buy Pressure (komponen terkuat) — max 40 pts
  if (buyPressureRatio5m >= 0.68)      score += 40;
  else if (buyPressureRatio5m >= 0.58) score += 32;
  else if (buyPressureRatio5m >= 0.52) score += 22;
  else if (buyPressureRatio5m >= 0.48) score += 10;
  // < 0.48 → sellers dominan → +0

  // 2. Volume Acceleration — max 30 pts
  if (volumeAcceleration >= 2.0)       score += 30;
  else if (volumeAcceleration >= 1.5)  score += 23;
  else if (volumeAcceleration >= 1.25) score += 15;
  else if (volumeAcceleration >= 1.1)  score += 8;
  // < 1.1 → flat atau turun → +0

  // 3. Price Momentum + Green Candle (kombinasi) — max 20 pts
  // priceMomentum: +20% price change = 1.0 (penuh), capped di 1.0
  const priceMomentumNorm = priceMomentum5m > 0
    ? Math.min(priceMomentum5m / 20, 1.0)
    : 0;
  const priceGreenScore = priceMomentumNorm * 0.6 + (greenCandlePct / 100) * 0.4;
  score += Math.round(priceGreenScore * 20);

  // 4. Swap Activity — max 10 pts
  if (priceInfo.swaps_5m >= 80)      score += 10;
  else if (priceInfo.swaps_5m >= 45) score += 6;

  // Bonus synergy: semua komponen positif secara bersamaan
  if (buyPressureRatio5m > 0.55 && volumeAcceleration > 1.3 && greenCandlePct > 55) {
    score += 5;
  }

  return {
    score: Math.min(Math.max(score, 0), 100),
    buyPressureRatio5m,
    volumeAcceleration,
    greenCandlePct,
    priceMomentum5m,
    swaps5m: priceInfo.swaps_5m,
  };
}
