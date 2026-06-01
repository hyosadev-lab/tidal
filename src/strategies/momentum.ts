import { type KlineCandle, type TokenInfo } from '../services/gmgn-client.ts';
import { avg } from '../utils/math.ts';

export interface MomentumSignal {
  score: number;
  // Komponen 1: buy pressure saat ini (5m window dari token_info)
  buyPressureRatio5m: number;
  // Komponen 2: volume acceleration dari kline
  volumeAcceleration: number;
  // Komponen 3: candle color pattern dari kline
  greenCandlePct: number;
  swaps5m: number;
}

export function scoreMomentum(
  candles: KlineCandle[],
  priceInfo: TokenInfo["price"],
): MomentumSignal {
  const volume5m = parseFloat(priceInfo.volume_5m);
  const buyVolume5m = parseFloat(priceInfo.buy_volume_5m);

  // ── Komponen 1: Buy pressure saat ini (5m) ───────────────────────────────
  const buyPressureRatio5m = volume5m > 0
    ? buyVolume5m / volume5m
    : 0.5;

  // ── Komponen 2 & 3: dari kline ───────────────────────────────────────────
  let volumeAcceleration = 0;
  let greenCandlePct = 0;

  if (candles.length >= 2) {
    // Volume acceleration: last 3 vs prior 3 candles
    const last3 = candles.slice(-3);
    const prior3 = candles.slice(-6, -3);
    const last3AvgVol = avg(last3.map((c) => parseFloat(c.volume)));
    const prior3AvgVol = prior3.length > 0
      ? avg(prior3.map((c) => parseFloat(c.volume)))
      : 0;
    volumeAcceleration = prior3AvgVol > 0 ? last3AvgVol / prior3AvgVol : 0;

    // Candle color pattern: % green candles in recent N candles
    const recentCandles = candles.slice(-6);
    const greenCount = recentCandles.filter(
      (c) => parseFloat(c.close) > parseFloat(c.open)
    ).length;
    greenCandlePct = recentCandles.length > 0
      ? (greenCount / recentCandles.length) * 100
      : 0;
  }

  // ── Scoring ──────────────────────────────────────────────────────────────
  let score = 0;

  // 1. Buy pressure saat ini — 5m window (+35 pts max)
  if (buyPressureRatio5m > 0.60) {
    score += 35;  // buyers dominan sekarang
  } else if (buyPressureRatio5m >= 0.50) {
    score += 20;  // sedikit lebih banyak buyer
  }
  // < 0.50 → sellers dominan → +0

  // 2. Volume acceleration dari kline (+30 pts max)
  if (volumeAcceleration > 1.5) {
    score += 30;  // momentum building kuat
  } else if (volumeAcceleration >= 1.2) {
    score += 20;  // momentum building
  }
  // < 1.2 → flat atau turun → +0

  // 3. Candle color pattern dari kline (+20 pts max)
  if (greenCandlePct >= 60) {
    score += 20;  // buyers konsisten
  } else if (greenCandlePct >= 40) {
    score += 10;  // netral
  }
  // < 40% → sellers dominan → +0

  // 4. Swap activity sekarang (+15 pts)
  if (priceInfo.swaps_5m >= 50) score += 15;

  return {
    score: Math.min(score, 100),
    buyPressureRatio5m,
    swaps5m: priceInfo.swaps_5m,
    volumeAcceleration,
    greenCandlePct,
  };
}
