import { type KlineCandle, type TokenInfo } from '../services/gmgn-client.ts';
import { avg } from '../utils/math.ts';

const FOMO_PRICE_THRESHOLD_PCT = 50; // konsisten dengan PRICE_PUMP_WARN_PCT di price-action.ts

export interface VolumeSurgeSignal {
  score: number;                    // 0-100

  // Core metrics
  surgeRatio: number;               // volume_5m / avg_volume_per_5m
  buyDominance: number;             // buy_volume_5m / total_volume_5m
  buyTxRatio: number;               // buys_5m / (buys + sells)
  swaps5m: number;

  // Acceleration
  volumeAcceleration: number;       // last 3 candles vs prior 3

  // Context
  isExplosive: boolean;             // surgeRatio >= 6.0
  isStrong: boolean;                // surgeRatio >= 3.5 && buyDominance >= 0.58
  isHealthy: boolean;               // surgeRatio >= 2.0 && buyDominance >= 0.55

  // Warning
  isSuspectedFomo: boolean;         // surge tinggi tapi harga sudah naik ekstrem
}

/**
 * @param candles      - kline candle terbaru, dipakai untuk volumeAcceleration
 * @param priceInfo    - token_info.price snapshot
 * @param priceChange5m - dihitung oleh scorePriceAction() dan diteruskan ke sini
 *                        secara eksplisit, supaya isSuspectedFomo tidak
 *                        menghitung ulang price change dengan definisi yang
 *                        bisa berbeda dari signal price-action (single source
 *                        of truth untuk price momentum ada di price-action.ts).
 */
export function scoreVolumeSurge(
  candles: KlineCandle[],
  priceInfo: TokenInfo['price'],
  priceChange5m: number,
): VolumeSurgeSignal {
  const volume5m = parseFloat(priceInfo.volume_5m);
  const volume1h = parseFloat(priceInfo.volume_1h);
  const buyVolume5m = parseFloat(priceInfo.buy_volume_5m);
  const buys5m = priceInfo.buys_5m;
  const sells5m = priceInfo.sells_5m;

  // ── Core metrics ─────────────────────────────────────────────────────
  const avgVolPer5m = volume1h > 0 ? volume1h / 12 : 0;
  const surgeRatio = avgVolPer5m > 0 ? volume5m / avgVolPer5m : 0;

  const buyDominance = volume5m > 0 ? buyVolume5m / volume5m : 0.5;
  const totalTx5m = buys5m + sells5m;
  const buyTxRatio = totalTx5m > 0 ? buys5m / totalTx5m : 0.5;

  // ── Acceleration ─────────────────────────────────────────────────────
  let volumeAcceleration = 0;
  if (candles.length >= 6) {
    const last3 = candles.slice(-3);
    const prior3 = candles.slice(-6, -3);
    const last3AvgVol = avg(last3.map((c) => parseFloat(c.volume)));
    const prior3AvgVol = avg(prior3.map((c) => parseFloat(c.volume)));
    volumeAcceleration = prior3AvgVol > 0 ? last3AvgVol / prior3AvgVol : 0;
  }

  // ── Context flags ────────────────────────────────────────────────────
  const isExplosive = surgeRatio >= 6.0;
  const isStrong = surgeRatio >= 3.5 && buyDominance >= 0.58;
  const isHealthy = surgeRatio >= 2.0 && buyDominance >= 0.55;

  // ── Warning: surge tinggi tapi harga sudah naik ekstrem ─────────────────
  // Surge volume yang muncul SETELAH pump besar sering berarti "orang FOMO
  // ikut beli di puncak", bukan "momentum baru mulai".
  const isSuspectedFomo = surgeRatio >= 2.5 && priceChange5m > FOMO_PRICE_THRESHOLD_PCT;

  // ── Scoring ──────────────────────────────────────────────────────────
  let score = 0;

  // 1. Surge Ratio — max 40 pts
  if (surgeRatio >= 6.0)      score += 40;
  else if (surgeRatio >= 3.5) score += 30;
  else if (surgeRatio >= 2.0) score += 18;
  else if (surgeRatio >= 1.2) score += 8;

  // 2. Buy Dominance — max 25 pts
  if (buyDominance >= 0.68)      score += 25;
  else if (buyDominance >= 0.58) score += 17;
  else if (buyDominance >= 0.50) score += 8;

  // 3. Volume Acceleration — max 20 pts
  if (volumeAcceleration >= 2.0)       score += 20;
  else if (volumeAcceleration >= 1.5)  score += 14;
  else if (volumeAcceleration >= 1.25) score += 8;
  else if (volumeAcceleration >= 1.1)  score += 4;

  // 4. Swap Intensity — max 15 pts
  if (priceInfo.swaps_5m >= 100)     score += 15;
  else if (priceInfo.swaps_5m >= 60) score += 9;
  else if (priceInfo.swaps_5m >= 30) score += 4;

  // ── Penalti FOMO — lebih berat dari sekadar redaman, karena sekarang
  // ini sinyal khusus (bukan komponen kecil di dalam momentum gabungan) ──
  if (isSuspectedFomo) {
    score *= 0.35; // potong tajam — surge tanpa konfirmasi "momentum baru" mencurigakan
  } else if (priceChange5m > FOMO_PRICE_THRESHOLD_PCT) {
    score *= 0.65; // priceChange tinggi tapi surge belum cukup kuat untuk masuk kategori isSuspectedFomo
  }

  return {
    score: Math.min(Math.max(Math.round(score), 0), 100),
    surgeRatio,
    buyDominance,
    buyTxRatio,
    swaps5m: priceInfo.swaps_5m,
    volumeAcceleration,
    isExplosive,
    isStrong,
    isHealthy,
    isSuspectedFomo,
  };
}
