import { type KlineCandle } from '../services/gmgn-client.ts';
import { avg } from '../utils/math.ts';

export interface MomentumSignal {
  score: number;
  volumeTrend: number;      // recentAvgVolume / overallAvgVolume ratio
  swaps1h: number;
  organicGrowth: boolean;   // volume rising WITHOUT any candle spike >100%
  priceChange5m: number;
  priceChange1h: number;
}

const MIN_SWAPS_1H = 500;

export function scoreMomentum(
  candles: KlineCandle[],
  swaps1h: number,
  priceChange5m: number,
  priceChange1h: number
): MomentumSignal {
  if (candles.length === 0) {
    return {
      score: 0,
      volumeTrend: 0,
      swaps1h,
      organicGrowth: false,
      priceChange5m,
      priceChange1h,
    };
  }

  // 1. Volume trend: recent 20% of candles vs overall average
  const recentCount = Math.max(Math.floor(candles.length * 0.2), 1);
  const recentCandles = candles.slice(-recentCount);
  const overallAvgVolume = avg(candles.map((c) => parseFloat(c.volume)));
  const recentAvgVolume = avg(recentCandles.map((c) => parseFloat(c.volume)));
  const volumeTrend = overallAvgVolume > 0 ? recentAvgVolume / overallAvgVolume : 0;

  // 2. Organic growth: volume rising but no single candle with >100% price spike
  const hasExtremePriceSpike = candles.some((c) => {
    const open = parseFloat(c.open);
    const close = parseFloat(c.close);
    if (open === 0) return false;
    return Math.abs((close - open) / open) > 1.0; // >100% in one candle
  });
  const organicGrowth = volumeTrend > 1.0 && !hasExtremePriceSpike;

  // ── Scoring ──────────────────────────────────────────────────────────────
  let score = 0;

  // Volume trend
  if (volumeTrend > 1.5) score += 30;

  // Swap activity
  if (swaps1h >= MIN_SWAPS_1H) score += 25;

  // Organic growth
  if (organicGrowth) score += 25;

  // Price momentum: both 5m and 1h positive
  if (priceChange5m > 0 && priceChange1h > 0) score += 20;

  return {
    score: Math.min(score, 100),
    volumeTrend,
    swaps1h,
    organicGrowth,
    priceChange5m,
    priceChange1h,
  };
}
