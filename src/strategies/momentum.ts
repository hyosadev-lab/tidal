import { type KlineCandle } from '../services/gmgn-client.ts';
import { avg } from '../utils/math.ts';

export interface MomentumSignal {
  score: number;
  buyPressureRatio: number;   // buy_volume_1h / (buy_volume_1h + sell_volume_1h)
  swaps1h: number;
  organicGrowth: boolean;     // no candle spike >100% AND priceChange1h < 200%
  volumeAcceleration: number; // last 3 candles avg volume vs prior 3 candles avg volume
  priceChange1h: number;
}

const MIN_SWAPS_1H = 500;
const MAX_ORGANIC_PRICE_CHANGE_1H = 200; // above this = already pumped, not organic accumulation

export function scoreMomentum(
  candles: KlineCandle[],
  swaps1h: number,
  buyVolume1h: number,
  sellVolume1h: number,
  priceChange1h: number,
): MomentumSignal {
  if (candles.length === 0) {
    return {
      score: 0,
      buyPressureRatio: 0.5,
      swaps1h,
      organicGrowth: false,
      volumeAcceleration: 0,
      priceChange1h,
    };
  }

  // 1. Buy pressure ratio — are buyers dominating sellers?
  const totalVolume1h = buyVolume1h + sellVolume1h;
  const buyPressureRatio = totalVolume1h > 0 ? buyVolume1h / totalVolume1h : 0.5;

  // 2. Organic growth:
  //    - No single candle with >100% price spike (not a flash pump)
  //    - 1h price change < 200% (not already pumped before our entry)
  const hasExtremeCandleSpike = candles.some((c) => {
    const open = parseFloat(c.open);
    const close = parseFloat(c.close);
    if (open === 0) return false;
    return Math.abs((close - open) / open) > 1.0;
  });
  const organicGrowth = !hasExtremeCandleSpike && priceChange1h < MAX_ORGANIC_PRICE_CHANGE_1H;

  // 3. Volume acceleration — is momentum building right now?
  //    Compare last 3 candles avg volume vs prior 3 candles avg volume
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
    score += 35;  // buyers clearly dominating
  } else if (buyPressureRatio >= 0.50) {
    score += 15;  // slight buy edge
  }
  // < 0.50 → sellers dominating → +0

  // 2. Swap activity (+20 pts)
  if (swaps1h >= MIN_SWAPS_1H) score += 20;

  // 3. Organic growth (+30 pts)
  //    Rewards tokens that haven't already pumped massively
  if (organicGrowth) score += 30;

  // 4. Volume acceleration (+15 pts)
  //    Rewards tokens where buying activity is picking up RIGHT NOW
  if (volumeAcceleration > 1.2) score += 15;

  return {
    score: Math.min(score, 100),
    buyPressureRatio,
    swaps1h,
    organicGrowth,
    volumeAcceleration,
    priceChange1h,
  };
}
