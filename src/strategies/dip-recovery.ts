import { type KlineCandle } from '../services/gmgn-client.ts';
import { getConfig, type KlineResolution, toCandles } from '../config.ts';
import { avg } from '../utils/math.ts';

export interface DipRecoverySignal {
  score: number;
  athPrice: number;
  dipFromAthPct: number;
  lowZoneCandles: number;
  volumeRecoveryPct: number;
}

export function scoreDipRecovery(
  candles: KlineCandle[],
  currentPrice: number,
  resolution: KlineResolution,
  lowZoneMinMinutes: number,
  lowZoneMaxMinutes: number,
  recoveryVolumeLookbackMinutes: number
): DipRecoverySignal {
  if (candles.length === 0) {
    return { score: 0, athPrice: 0, dipFromAthPct: 0, lowZoneCandles: 0, volumeRecoveryPct: 0 };
  }

  const config = getConfig();

  // 1. ATH from all candles since graduation
  const athPrice = Math.max(...candles.map((c) => parseFloat(c.high)));

  // 2. Dip from ATH
  const dipFromAthPct = athPrice > 0
    ? ((athPrice - currentPrice) / athPrice) * 100
    : 0;

  // ── Gate: token not in sweet spot dip range ───────────────────────────────
  if (dipFromAthPct < config.minDipFromAthPct) {
    return { score: 0, athPrice, dipFromAthPct, lowZoneCandles: 0, volumeRecoveryPct: 0 };
  }

  if (dipFromAthPct > config.maxDipFromAthPct) {
    return { score: 15, athPrice, dipFromAthPct, lowZoneCandles: 0, volumeRecoveryPct: 0 };
  }

  let score = 40;

  // 3. Low zone: candles within ±20% of current price
  const lowZoneCandleList = candles.filter((c) => {
    const close = parseFloat(c.close);
    return Math.abs(close - currentPrice) / currentPrice <= 0.20;
  });
  const lowZoneCandles = lowZoneCandleList.length;

  const lowZoneMinCandles = toCandles(lowZoneMinMinutes, resolution);
  const lowZoneMaxCandles = toCandles(lowZoneMaxMinutes, resolution);

  if (lowZoneCandles >= lowZoneMinCandles && lowZoneCandles <= lowZoneMaxCandles) {
    score += 30;
  } else if (lowZoneCandles > lowZoneMaxCandles) {
    score += 5;
  }
  // lowZoneCandles < lowZoneMinCandles → +0 pts

  // 4. Recovery volume: recent N candles vs low zone average
  const recoveryLookback = toCandles(recoveryVolumeLookbackMinutes, resolution);
  const recentCandles = candles.slice(-Math.max(recoveryLookback, 1));
  const recentAvgVolume = avg(recentCandles.map((c) => parseFloat(c.volume)));
  const lowZoneAvgVolume = lowZoneCandleList.length > 0
    ? avg(lowZoneCandleList.map((c) => parseFloat(c.volume)))
    : 0;

  const volumeRecoveryPct = lowZoneAvgVolume > 0
    ? ((recentAvgVolume - lowZoneAvgVolume) / lowZoneAvgVolume) * 100
    : 0;

  if (volumeRecoveryPct > 50) {
    score += 30;
  } else if (volumeRecoveryPct >= 20) {
    score += 20;
  } else if (volumeRecoveryPct < -30) {
    // Volume sedang collapse — penalty, bukan recovery
    score -= 15;
  }

  return {
    score: Math.max(0, Math.min(score, 100)),
    athPrice,
    dipFromAthPct,
    lowZoneCandles,
    volumeRecoveryPct,
  };
}
