import { type KlineCandle } from '../services/gmgn-client.ts';
import { avg } from '../utils/math.ts';

export interface MomentumSignal {
  score: number;
  buyPressureRatio: number;
  swaps1h: number;
  organicGrowth: boolean;
  volumeAcceleration: number;
  priceChangePct: number;         // priceChangeSinceGrad if < 60 min, priceChange1h if >= 60 min
  priceChangeSinceGrad: number;   // always available for logging/prompt
  priceChange1h: number;          // always available for logging/prompt
}

const MIN_SWAPS_1H = 500;
const MAX_ORGANIC_PRICE_CHANGE_PCT = 150; // above this = not organic accumulation

export function scoreMomentum(
  candles: KlineCandle[],
  swaps1h: number,
  buyVolume1h: number,
  sellVolume1h: number,
  priceChangeSinceGrad: number,
  priceChange1h: number,
  minutesSinceGraduation: number,
): MomentumSignal {
  // Use priceChangeSinceGrad if token graduated < 60 min ago,
  // otherwise priceChange1h is fully post-graduation and more reliable
  const priceChangePct = minutesSinceGraduation < 60
    ? priceChangeSinceGrad
    : priceChange1h;

  if (candles.length === 0) {
    return {
      score: 0,
      buyPressureRatio: 0.5,
      swaps1h,
      organicGrowth: false,
      volumeAcceleration: 0,
      priceChangePct,
      priceChangeSinceGrad,
      priceChange1h,
    };
  }

  // 1. Buy pressure ratio
  const totalVolume1h = buyVolume1h + sellVolume1h;
  const buyPressureRatio = totalVolume1h > 0 ? buyVolume1h / totalVolume1h : 0.5;

  // 2. Organic growth:
  const organicGrowth = priceChangePct < MAX_ORGANIC_PRICE_CHANGE_PCT;

  // 3. Volume acceleration
  const last3 = candles.slice(-3);
  const prior3 = candles.slice(-6, -3);
  const last3AvgVolume = avg(last3.map((c) => parseFloat(c.volume)));
  const prior3AvgVolume = prior3.length > 0
    ? avg(prior3.map((c) => parseFloat(c.volume)))
    : 0;
  const volumeAcceleration = prior3AvgVolume > 0
    ? last3AvgVolume / prior3AvgVolume
    : 0;

  // ── Scoring ──────────────────────────────────────────────────────────────
  let score = 0;

  // 1. Buy pressure quality (+35 pts max)
  if (buyPressureRatio > 0.55) {
    score += 35;
  } else if (buyPressureRatio >= 0.50) {
    score += 15;
  }

  // 2. Swap activity (+20 pts)
  if (swaps1h >= MIN_SWAPS_1H) score += 20;

  // 3. Organic growth (+30 pts)
  if (organicGrowth) score += 30;

  // 4. Volume acceleration (+15 pts)
  if (volumeAcceleration > 1.2) score += 15;

  return {
    score: Math.min(score, 100),
    buyPressureRatio,
    swaps1h,
    organicGrowth,
    volumeAcceleration,
    priceChangePct,
    priceChangeSinceGrad,
    priceChange1h,
  };
}
