import { type KlineCandle } from '../services/gmgn-client.ts';

export interface DipRecoverySignal {
  score: number;
  athPrice: number;
  dipFromAthPct: number;
  hasLowerLow: boolean;       // true = downtrend still forming (bad)
  buyVolumeRatio5m: number;   // buy_volume_5m / total_volume_5m
  buyTxRatio5m: number;       // buys_5m / (buys_5m + sells_5m)
}

export function scoreDipRecovery(
  candles: KlineCandle[],
  currentPrice: number,
  buyVolume5m: number,
  sellVolume5m: number,
  buys5m: number,
  sells5m: number,
): DipRecoverySignal {
  if (candles.length === 0) {
    return {
      score: 0,
      athPrice: 0,
      dipFromAthPct: 0,
      hasLowerLow: false,
      buyVolumeRatio5m: 0,
      buyTxRatio5m: 0,
    };
  }

  // ── Komponen 1: Dip depth dari ATH ───────────────────────────────────────
  const athPrice = Math.max(...candles.map((c) => parseFloat(c.high)));
  const dipFromAthPct = athPrice > 0
    ? ((athPrice - currentPrice) / athPrice) * 100
    : 0;

  // Gate: hanya sweet spot yang dilanjutkan
  if (dipFromAthPct < 50) {
    return { score: 0, athPrice, dipFromAthPct, hasLowerLow: false, buyVolumeRatio5m: 0, buyTxRatio5m: 0 };
  }
  if (dipFromAthPct > 80) {
    return { score: 15, athPrice, dipFromAthPct, hasLowerLow: false, buyVolumeRatio5m: 0, buyTxRatio5m: 0 };
  }

  // Tiered base score berdasarkan kedalaman dip
  let score = 0;
  if (dipFromAthPct >= 70) {
    score = 40;
  } else if (dipFromAthPct >= 60) {
    score = 32;
  } else {
    score = 25;
  }

  // ── Komponen 2: Downtrend melambat — dari kline ───────────────────────────
  // Bandingkan lowest low dari 3 candles terakhir vs 3 candles sebelumnya
  const windowSize = 3;
  const lastN = candles.slice(-windowSize);
  const prevN = candles.slice(-(windowSize * 2), -windowSize);

  const lastLow = Math.min(...lastN.map((c) => parseFloat(c.low)));
  const prevLow = prevN.length > 0
    ? Math.min(...prevN.map((c) => parseFloat(c.low)))
    : lastLow;

  // hasLowerLow = true berarti token masih membuat low baru (downtrend berlanjut)
  const hasLowerLow = prevN.length > 0 && lastLow < prevLow;

  if (!hasLowerLow) {
    score += 20;  // downtrend melambat, tidak membuat lower low
  }

  // ── Komponen 3: Buy volume dominan — dari token_info 5m ──────────────────
  const totalVolume5m = buyVolume5m + sellVolume5m;
  const buyVolumeRatio5m = totalVolume5m > 0
    ? buyVolume5m / totalVolume5m
    : 0.5;

  if (buyVolumeRatio5m > 0.60) {
    score += 25;  // buyers dominan secara dollar value
  } else if (buyVolumeRatio5m >= 0.50) {
    score += 15;  // sedikit lebih banyak buyer
  }

  // ── Komponen 4: Lebih banyak buyer dari seller — dari token_info 5m ───────
  const totalTx5m = buys5m + sells5m;
  const buyTxRatio5m = totalTx5m > 0
    ? buys5m / totalTx5m
    : 0.5;

  if (buyTxRatio5m > 0.60) {
    score += 15;  // lebih banyak transaksi beli
  } else if (buyTxRatio5m >= 0.50) {
    score += 8;
  }

  return {
    score: Math.max(0, Math.min(score, 100)),
    athPrice,
    dipFromAthPct,
    hasLowerLow,
    buyVolumeRatio5m,
    buyTxRatio5m,
  };
}
