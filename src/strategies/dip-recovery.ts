import { type KlineCandle } from '../services/gmgn-client.ts';
import { type KlineResolution, toCandles } from '../config.ts';
import { avg } from '../utils/math.ts';

export interface DipRecoverySignal {
  score: number;
  athPrice: number;
  dipFromAthPct: number;
  // Komponen 2: price range stability
  priceRangePct: number;
  // Komponen 3: lower low check
  hasLowerLow: boolean;
  // Komponen 4: volume pattern
  volumeRatio: number;
  hasBuyerReturn: boolean;
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
    return {
      score: 0,
      athPrice: 0,
      dipFromAthPct: 0,
      priceRangePct: 0,
      hasLowerLow: false,
      volumeRatio: 0,
      hasBuyerReturn: false,
    };
  }

  // ── Komponen 1: Dip depth dari ATH ───────────────────────────────────────
  const athPrice = Math.max(...candles.map((c) => parseFloat(c.high)));
  const dipFromAthPct = athPrice > 0
    ? ((athPrice - currentPrice) / athPrice) * 100
    : 0;

  // Gate: hanya sweet spot yang dilanjutkan
  if (dipFromAthPct < 40) {
    return { score: 0, athPrice, dipFromAthPct, priceRangePct: 0, hasLowerLow: false, volumeRatio: 0, hasBuyerReturn: false };
  }
  if (dipFromAthPct > 70) {
    return { score: 15, athPrice, dipFromAthPct, priceRangePct: 0, hasLowerLow: false, volumeRatio: 0, hasBuyerReturn: false };
  }

  // Tiered base score
  let score = 0;
  if (dipFromAthPct >= 60) {
    score = 40;
  } else if (dipFromAthPct >= 50) {
    score = 32;
  } else {
    score = 25;
  }

  // ── Komponen 2: Price range stability ────────────────────────────────────
  // Ukur seberapa sideways N candles terakhir
  const lookbackCandles = Math.max(toCandles(recoveryVolumeLookbackMinutes, resolution), 3);
  const recentCandles = candles.slice(-lookbackCandles);

  const recentHighest = Math.max(...recentCandles.map((c) => parseFloat(c.high)));
  const recentLowest = Math.min(...recentCandles.map((c) => parseFloat(c.low)));
  const priceRangePct = recentLowest > 0
    ? ((recentHighest - recentLowest) / recentLowest) * 100
    : 100;

  if (priceRangePct < 15) {
    score += 25;  // sideways ketat → konsolidasi solid
  } else if (priceRangePct <= 30) {
    score += 15;  // sideways longgar → ada sedikit volatilitas
  }
  // > 30% → masih terlalu volatile → +0

  // ── Komponen 3: Lower low check ──────────────────────────────────────────
  // Apakah downtrend sudah berhenti?
  const windowSize = 3;
  const lastN = candles.slice(-windowSize);
  const prevN = candles.slice(-(windowSize * 2), -windowSize);

  const lastLow = prevN.length > 0
    ? Math.min(...lastN.map((c) => parseFloat(c.low)))
    : 0;
  const prevLow = prevN.length > 0
    ? Math.min(...prevN.map((c) => parseFloat(c.low)))
    : 0;

  // hasLowerLow = true berarti masih turun (bad)
  const hasLowerLow = prevN.length > 0 && lastLow < prevLow;

  if (!hasLowerLow && prevN.length > 0) {
    score += 15;  // tidak membuat lower low → downtrend mungkin sudah berhenti
  }

  // ── Komponen 4: Volume pattern ────────────────────────────────────────────
  // Seller exhaustion + buyer return
  // Split recent candles menjadi dua bagian
  const half = Math.max(Math.floor(recentCandles.length / 2), 1);
  const firstHalf = recentCandles.slice(0, half);
  const secondHalf = recentCandles.slice(half);

  const firstHalfAvgVol = avg(firstHalf.map((c) => parseFloat(c.volume)));
  const secondHalfAvgVol = avg(secondHalf.map((c) => parseFloat(c.volume)));

  const volumeRatio = firstHalfAvgVol > 0
    ? secondHalfAvgVol / firstHalfAvgVol
    : 0;

  // Buyer return: ada minimal 1 candle hijau di second half
  const hasBuyerReturn = secondHalf.some(
    (c) => parseFloat(c.close) > parseFloat(c.open)
  );

  if (volumeRatio > 1.2 && hasBuyerReturn) {
    score += 20;  // volume naik + ada candle hijau → buyers returning
  } else if (volumeRatio > 1.0) {
    score += 10;  // volume sedikit naik
  }

  return {
    score: Math.max(0, Math.min(score, 100)),
    athPrice,
    dipFromAthPct,
    priceRangePct,
    hasLowerLow,
    volumeRatio,
    hasBuyerReturn,
  };
}
