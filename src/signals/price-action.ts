import { type KlineCandle, type TokenInfo } from '../services/gmgn-client.ts';

// ── FOMO / late-entry guard thresholds ────────────────────────────────────
// Berdasarkan data log: entry dengan priceChange5m > 50% sering berujung
// loss besar (-30% s/d -55%) — dipertahankan dari strategies/momentum.ts lama.
const PRICE_PUMP_WARN_PCT    = 50;
const PRICE_PUMP_SEVERE_PCT  = 80;
const PRICE_PUMP_EXTREME_PCT = 120;

export interface PriceActionSignal {
  score: number;                    // 0-100

  // Momentum
  priceChange5m: number;            // percentage
  priceChange15m: number;
  priceChange1h: number;

  // Candle Pattern
  greenCandlePct: number;           // % green candles in last 8-10
  hasStrongBullCandle: boolean;
  hasRejectionWick: boolean;

  // Risk / FOMO Detection
  isLateEntry: boolean;
  fomoPenalty: number;
  momentumLevel: 'early' | 'healthy' | 'extended' | 'extreme';

  // Overall assessment
  isBullish: boolean;
  isStable: boolean;
}

/**
 * @param candles   - kline candle terbaru, dipakai untuk candle pattern &
 *                    priceChange15m (lihat catatan di bawah)
 * @param priceInfo - token_info.price snapshot; sumber priceChange5m/1h
 *
 * CATATAN priceChange15m: GMGN token/info TIDAK menyediakan snapshot 15m
 * (hanya 1m/5m/1h/6h/24h). Nilai ini di-derive manual dari kline — mencari
 * candle dengan timestamp ~15 menit lalu, bandingkan close-nya dengan harga
 * sekarang. Kalau history candle tidak cukup panjang (token baru), nilainya
 * fallback ke 0 — BUKAN representasi akurat, cuma "tidak diketahui".
 */
export function scorePriceAction(
  candles: KlineCandle[],
  priceInfo: TokenInfo['price'],
): PriceActionSignal {
  const currentPrice = parseFloat(priceInfo.price);
  const price5mAgo = parseFloat(priceInfo.price_5m);
  const price1hAgo = parseFloat(priceInfo.price_1h);

  const priceChange5m = price5mAgo > 0 ? ((currentPrice - price5mAgo) / price5mAgo) * 100 : 0;
  const priceChange1h = price1hAgo > 0 ? ((currentPrice - price1hAgo) / price1hAgo) * 100 : 0;

  // ── priceChange15m: derive dari kline (lihat catatan di atas) ───────────
  let priceChange15m = 0;
  if (candles.length > 0) {
    const targetTime = Date.now() - 15 * 60 * 1000;
    // Cari candle terakhir yang time-nya <= targetTime (paling dekat ke 15m lalu)
    const candidate = [...candles]
      .filter((c) => c.time <= targetTime)
      .sort((a, b) => b.time - a.time)[0];
    if (candidate) {
      const price15mAgo = parseFloat(candidate.close);
      if (price15mAgo > 0) {
        priceChange15m = ((currentPrice - price15mAgo) / price15mAgo) * 100;
      }
    }
    // Kalau tidak ada candle cukup lama (token baru), priceChange15m tetap 0
  }

  // ── Candle Pattern ───────────────────────────────────────────────────
  let greenCandlePct = 0;
  let hasStrongBullCandle = false;
  let hasRejectionWick = false;

  if (candles.length > 0) {
    const recentCandles = candles.slice(-8);
    const greenCount = recentCandles.filter(
      (c) => parseFloat(c.close) > parseFloat(c.open)
    ).length;
    greenCandlePct = (greenCount / recentCandles.length) * 100;

    // Strong bull candle: body besar (>15% dari open) di salah satu candle terakhir
    hasStrongBullCandle = recentCandles.some((c) => {
      const open = parseFloat(c.open);
      const close = parseFloat(c.close);
      if (open === 0) return false;
      return (close - open) / open > 0.15;
    });

    // Rejection wick pada candle terakhir — lower wick panjang, close di atas
    const last = candles[candles.length - 1]!;
    const open = parseFloat(last.open);
    const close = parseFloat(last.close);
    const high = parseFloat(last.high);
    const low = parseFloat(last.low);
    const range = high - low;
    if (range > 0) {
      const lowerWick = Math.min(open, close) - low;
      const closePosition = (close - low) / range;
      hasRejectionWick = lowerWick / range > 0.4 && closePosition > 0.5;
    }
  }

  // ── FOMO Guard ───────────────────────────────────────────────────────
  let fomoPenalty = 0;
  let momentumLevel: PriceActionSignal['momentumLevel'] = 'early';

  if (priceChange5m > PRICE_PUMP_EXTREME_PCT) {
    fomoPenalty = 60;
    momentumLevel = 'extreme';
  } else if (priceChange5m > PRICE_PUMP_SEVERE_PCT) {
    fomoPenalty = 40;
    momentumLevel = 'extended';
  } else if (priceChange5m > PRICE_PUMP_WARN_PCT) {
    fomoPenalty = 22;
    momentumLevel = 'extended';
  } else if (priceChange5m > 20) {
    momentumLevel = 'healthy';
  } else {
    momentumLevel = 'early';
  }

  const isLateEntry = priceChange5m > PRICE_PUMP_WARN_PCT;

  // ── Scoring ──────────────────────────────────────────────────────────
  let score = 0;

  // 1. Price momentum — peak di ~20%, turun lagi di atas itu (anti buy-the-top) — max 45 pts
  let priceMomentumNorm: number;
  if (priceChange5m <= 0) {
    priceMomentumNorm = 0;
  } else if (priceChange5m <= 20) {
    priceMomentumNorm = priceChange5m / 20;
  } else if (priceChange5m <= PRICE_PUMP_WARN_PCT) {
    priceMomentumNorm = 1.0 - ((priceChange5m - 20) / (PRICE_PUMP_WARN_PCT - 20)) * 0.2;
  } else {
    const overshoot = priceChange5m - PRICE_PUMP_WARN_PCT;
    priceMomentumNorm = Math.max(0.8 - overshoot / 100, 0);
  }
  score += Math.round(priceMomentumNorm * 45);

  // 2. Green candle pct — max 20 pts
  score += Math.round((greenCandlePct / 100) * 20);

  // 3. Strong bull candle — max 15 pts
  if (hasStrongBullCandle) score += 15;

  // 4. Rejection wick (confirmasi buyer masuk di dip lokal) — max 10 pts
  if (hasRejectionWick) score += 10;

  // 5. 1h trend confirmation — priceChange1h positif tapi tidak ekstrem — max 10 pts
  if (priceChange1h > 0 && priceChange1h < 100) score += 10;
  else if (priceChange1h > 0) score += 4;

  // ── Terapkan penalti FOMO ────────────────────────────────────────────
  score -= fomoPenalty;

  const isBullish = priceChange5m > 0 && greenCandlePct >= 50;
  const isStable = !isLateEntry && Math.abs(priceChange5m) < 30;

  return {
    score: Math.min(Math.max(score, 0), 100),
    priceChange5m,
    priceChange15m,
    priceChange1h,
    greenCandlePct,
    hasStrongBullCandle,
    hasRejectionWick,
    isLateEntry,
    fomoPenalty,
    momentumLevel,
    isBullish,
    isStable,
  };
}
