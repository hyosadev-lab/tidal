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

  // ── Scoring ──────────────────────────────────────────────────────────────

  // Gate 1: token not in sweet spot dip range → low zone & volume not relevant
  if (dipFromAthPct < config.minDipFromAthPct) {
    // Token at or near ATH, or shallow dip — not a dip buy opportunity
    return { score: 0, athPrice, dipFromAthPct, lowZoneCandles: 0, volumeRecoveryPct: 0 };
  }

  if (dipFromAthPct > config.maxDipFromAthPct) {
    // Too deep — might be dead/rug, low zone & volume recovery not relevant
    return { score: 15, athPrice, dipFromAthPct, lowZoneCandles: 0, volumeRecoveryPct: 0 };
  }

  // Sweet spot: dipFromAthPct 60–70%
  // Now low zone and volume recovery are meaningful
  let score = 40;

  // 3. Low zone: candles within ±20% of current price
  //    Valid only in sweet spot — current price is already significantly below ATH
  const lowZoneCandleList = candles.filter((c) => {
    const close = parseFloat(c.close);
    return Math.abs(close - currentPrice) / currentPrice <= 0.20;
  });
  const lowZoneCandles = lowZoneCandleList.length;

  const lowZoneMinCandles = toCandles(lowZoneMinMinutes, resolution);
  const lowZoneMaxCandles = toCandles(lowZoneMaxMinutes, resolution);

  if (lowZoneCandles >= lowZoneMinCandles && lowZoneCandles <= lowZoneMaxCandles) {
    score += 30;  // healthy consolidation at bottom
  } else if (lowZoneCandles > lowZoneMaxCandles) {
    score += 5;   // too long at bottom — might be dead
  }
  // lowZoneCandles < lowZoneMinCandles → +0 pts (just started dropping, not consolidated yet)

  // 4. Recovery volume: recent N candles vs low zone average
  //    Valid only in sweet spot — meaningful only when consolidation exists
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
  }
  // else: +0

  return {
    score: Math.min(score, 100),
    athPrice,
    dipFromAthPct,
    lowZoneCandles,
    volumeRecoveryPct,
  };
}
