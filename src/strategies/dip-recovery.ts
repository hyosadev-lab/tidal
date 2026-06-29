import { type KlineCandle, type TokenInfo } from "../services/gmgn-client.ts";

const SWEET_SPOT = 73;
const MIN_DIP = 50;
const MAX_DIP = 90;

export interface DipRecoverySignal {
  score: number;
  athPrice: number;
  dipFromAthPct: number;
  hasLowerLow: boolean; // true = downtrend still forming (bad)
  buyVolumeRatio5m: number; // buy_volume_5m / total_volume_5m
  buyTxRatio5m: number; // buys_5m / (buys_5m + sells_5m)
}

export function scoreDipRecovery(
  candles: KlineCandle[],
  tokenInfo: TokenInfo,
): DipRecoverySignal {
  const athPrice = tokenInfo.ath_price;
  const currentPrice = parseFloat(tokenInfo.price.price);
  const buyVolume5m = parseFloat(tokenInfo.price.buy_volume_5m);
  const sellVolume5m = parseFloat(tokenInfo.price.sell_volume_5m);
  const buys5m = tokenInfo.price.buys_5m;
  const sells5m = tokenInfo.price.sells_5m;

  if (candles.length === 0 || athPrice <= 0) {
    return {
      score: 0,
      athPrice,
      dipFromAthPct: 0,
      hasLowerLow: false,
      buyVolumeRatio5m: 0,
      buyTxRatio5m: 0,
    };
  }

  // ── Komponen 1: Dip depth dari ATH ───────────────────────────────────────
  // athPrice sekarang berasal dari info.price.ath_price (token/info) — ATH
  // sepanjang umur token, bukan lagi Math.max dari kline window yang di-fetch.
  const dipFromAthPct = ((athPrice - currentPrice) / athPrice) * 100;

  // Gate: hanya sweet spot yang dilanjutkan
  if (dipFromAthPct < MIN_DIP) {
    return {
      score: 0,
      athPrice,
      dipFromAthPct,
      hasLowerLow: false,
      buyVolumeRatio5m: 0,
      buyTxRatio5m: 0,
    };
  }
  if (dipFromAthPct > MAX_DIP) {
    return {
      score: 15,
      athPrice,
      dipFromAthPct,
      hasLowerLow: false,
      buyVolumeRatio5m: 0,
      buyTxRatio5m: 0,
    };
  }

  // Gate: dead cat bounce — ada candle spike >100% di 3 candles terakhir
  // Candle naik >100% setelah downtrend panjang = kemungkinan besar bukan genuine recovery
  const recentCandles = candles.slice(-3);
  const hasRecentSpike = recentCandles.some((c) => {
    const open = parseFloat(c.open);
    const close = parseFloat(c.close);
    if (open === 0) return false;
    return (close - open) / open > 1.0;
  });

  if (hasRecentSpike) {
    return {
      score: 0,
      athPrice,
      dipFromAthPct,
      hasLowerLow: false,
      buyVolumeRatio5m: 0,
      buyTxRatio5m: 0,
    };
  }

  // Tiered base score berdasarkan kedalaman dip
  const distance = Math.abs(dipFromAthPct - SWEET_SPOT);
  const maxDistance = Math.max(SWEET_SPOT - MIN_DIP, MAX_DIP - SWEET_SPOT);

  let score = Math.round(40 * (1 - distance / maxDistance));

  // ── Komponen 2: Downtrend melambat — dari kline ───────────────────────────
  // Bandingkan lowest low dari 3 candles terakhir vs 3 candles sebelumnya
  const windowSize = 3;
  const lastN = candles.slice(-windowSize);
  const prevN = candles.slice(-(windowSize * 2), -windowSize);

  const lastLow = Math.min(...lastN.map((c) => parseFloat(c.low)));
  const prevLow =
    prevN.length > 0
      ? Math.min(...prevN.map((c) => parseFloat(c.low)))
      : lastLow;

  // hasLowerLow = true berarti token masih membuat low baru (downtrend berlanjut)
  const hasLowerLow = prevN.length > 0 && lastLow < prevLow;

  if (!hasLowerLow) {
    score += 20; // downtrend melambat, tidak membuat lower low
  }

  // ── Komponen 3: Buy volume dominan — dari token_info 5m ──────────────────
  const totalVolume5m = buyVolume5m + sellVolume5m;
  const buyVolumeRatio5m =
    totalVolume5m > 0 ? buyVolume5m / totalVolume5m : 0.5;

  if (buyVolumeRatio5m > 0.6) {
    score += 25; // buyers dominan secara dollar value
  } else if (buyVolumeRatio5m >= 0.5) {
    score += 15; // sedikit lebih banyak buyer
  }

  // ── Komponen 4: Lebih banyak buyer dari seller — dari token_info 5m ───────
  const totalTx5m = buys5m + sells5m;
  const buyTxRatio5m = totalTx5m > 0 ? buys5m / totalTx5m : 0.5;

  if (buyTxRatio5m > 0.6) {
    score += 15; // lebih banyak transaksi beli
  } else if (buyTxRatio5m >= 0.5) {
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
