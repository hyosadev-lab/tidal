/**
 * Calculate volume deltas for last N candles
 * Returns formatted string: "Volume Deltas: +100%, -25%, +50%"
 * Klines format: [open, high, low, close, volume]
 */
export function calculateVolumeDeltas(
  klines: number[][],
  limit: number,
): string {
  if (klines.length < 2) {
    return "Volume Deltas: N/A (insufficient data)";
  }

  const deltas: string[] = [];
  const startIdx = Math.max(0, klines.length - limit);

  for (let i = startIdx + 1; i < klines.length; i++) {
    const prevKline = klines[i - 1];
    const currKline = klines[i];

    if (!prevKline || !currKline) continue; // Safety check

    const prevVolume = prevKline[4]; // volume is at index 4 (no timestamp)
    const currVolume = currKline[4];

    // Check if volume data exists
    if (prevVolume === undefined || currVolume === undefined) {
      deltas.push("N/A");
      continue;
    }

    if (prevVolume === 0) {
      deltas.push("N/A");
      continue;
    }

    const deltaPercent = ((currVolume - prevVolume) / prevVolume) * 100;
    const sign = deltaPercent >= 0 ? "+" : "";
    deltas.push(`${sign}${deltaPercent.toFixed(1)}%`);
  }

  return `Volume Deltas (${deltas.length} changes): ${deltas.join(", ")}`;
}

/**
 * Get volume deltas from kline array
 * Accepts raw kline array from GMGN API directly
 */
export function getVolumeDeltasFromKline(
  klines: number[][],
  limit: number = 5,
): string {
  return calculateVolumeDeltas(klines, limit);
}

/**
 * Analyze last 10 candles for technical patterns
 * Klines format: [open, high, low, close, volume]
 */
export function getCandlePatterns(klines: number[][]): string {
  if (klines.length < 10) {
    return "Candle Patterns: N/A (insufficient data)";
  }

  const lastTenCandles = klines.slice(-10);

  let upperWickCount = 0;
  for (const candle of lastTenCandles) {
    const [, high, low, close] = candle;
    const range = high - low;
    if (range === 0) continue;
    const upperWickRatio = (high - close) / range;
    if (upperWickRatio > 0.6) {
      upperWickCount++;
    }
  }

  const lastCandle = klines[klines.length - 1];
  const [lastOpen, lastHigh, lastLow, lastClose] = lastCandle;
  const lastRange = lastHigh - lastLow;
  let bodyRatio = 0;
  if (lastRange !== 0) {
    bodyRatio = Math.abs(lastClose - lastOpen) / lastRange;
  }
  const bodyDescription =
    bodyRatio > 0.7
      ? "strong conviction"
      : bodyRatio >= 0.3
        ? "moderate"
        : "indecision/doji";

  const closePrices = lastTenCandles.map((c) => c[3]);
  const avgClose = closePrices.reduce((a, b) => a + b, 0) / closePrices.length;
  const variance =
    closePrices.reduce((sum, price) => sum + Math.pow(price - avgClose, 2), 0) /
    closePrices.length;
  const stdDev = Math.sqrt(variance);
  const stdDevPercent = (stdDev / avgClose) * 100;
  const consolidationDesc =
    stdDevPercent < 2
      ? "tight (accumulation possible)"
      : stdDevPercent <= 5
        ? "moderate"
        : "wide (volatile)";

  const lastVolume = lastCandle[4];
  const prevNineVolumes = lastTenCandles.slice(0, 9).map((c) => c[4]);
  const avgPrevVolume =
    prevNineVolumes.reduce((a, b) => a + b, 0) / prevNineVolumes.length;
  let volumeDescription = "Normal";
  let spikeRatio = 0;
  if (avgPrevVolume > 0) {
    spikeRatio = lastVolume / avgPrevVolume;
    if (spikeRatio > 2.0) {
      volumeDescription = `YES ${spikeRatio.toFixed(1)}x avg (breakout confirmation)`;
    } else if (spikeRatio < 0.5) {
      volumeDescription = `LOW ${spikeRatio.toFixed(1)}x avg`;
    } else {
      volumeDescription = `Normal ${spikeRatio.toFixed(1)}x avg`;
    }
  }

  return (
    `Candle Patterns (1m):\n` +
    `- Upper wick dominance: ${upperWickCount}/10 last candles (distribution signal)\n` +
    `- Last candle body ratio: ${bodyRatio.toFixed(2)} (${bodyDescription})\n` +
    `- Consolidation: price std dev ${stdDevPercent.toFixed(1)}% last 10 candles (${consolidationDesc})\n` +
    `- Volume spike: ${volumeDescription}`
  );
}

/**
 * Cumulative Volume Delta proxy (CVD)
 * Bullish candles add volume, bearish candles subtract
 * Klines format: [open, high, low, close, volume]
 */
export function getCVDProxy(klines: number[][]): string {
  if (klines.length < 5) {
    return "CVD Proxy: N/A (insufficient data)";
  }

  let cvdNet = 0;
  for (const candle of klines) {
    const [open, , , close, volume] = candle;
    if (close >= open) {
      cvdNet += volume;
    } else {
      cvdNet -= volume;
    }
  }

  const lastFiveCandles = klines.slice(-5);
  let cvdLast5 = 0;
  for (const candle of lastFiveCandles) {
    const [open, , , close, volume] = candle;
    if (close >= open) {
      cvdLast5 += volume;
    } else {
      cvdLast5 -= volume;
    }
  }
  const trendDesc =
    cvdLast5 > 0 ? "Rising" : cvdLast5 < 0 ? "Falling" : "Flat";

  const firstClose = klines[0][3];
  const lastClose = klines[klines.length - 1][3];
  const priceChange = ((lastClose - firstClose) / firstClose) * 100;

  let divergenceDesc = "No divergence";
  if (priceChange < -3 && cvdNet > 0) {
    divergenceDesc =
      "Accumulation divergence (price falling, buying pressure)";
  } else if (priceChange > 3 && cvdNet < 0) {
    divergenceDesc = "Distribution divergence (price rising, selling pressure)";
  }

  const pressureDesc =
    cvdNet > 0
      ? "bullish pressure dominant"
      : cvdNet < 0
        ? "bearish pressure dominant"
        : "neutral";

  const cvdFormatted =
    Math.abs(cvdNet) >= 1
      ? (cvdNet > 0 ? "+" : "") + cvdNet.toFixed(0)
      : (cvdNet > 0 ? "+" : "") + cvdNet.toFixed(2);

  return (
    `CVD Proxy (1m, ${klines.length} candles):\n` +
    `- Net: ${cvdFormatted} (${pressureDesc})\n` +
    `- Trend: ${trendDesc} (last 5 candles net ${cvdLast5 > 0 ? "positive" : cvdLast5 < 0 ? "negative" : "neutral"})\n` +
    `- Divergence: ${divergenceDesc}`
  );
}

/**
 * Volume distribution analysis across candles
 * Klines format: [open, high, low, close, volume]
 */
export function getVolumeProfile(klines: number[][]): string {
  if (klines.length < 4) {
    return "Volume Profile: N/A (insufficient data)";
  }

  const volumes = klines.map((c) => c[4]);
  const avgVolume = volumes.reduce((a, b) => a + b, 0) / volumes.length;

  const midPoint = Math.floor(klines.length / 2);
  const firstHalfVolumes = volumes.slice(0, midPoint);
  const secondHalfVolumes = volumes.slice(midPoint);

  const avgFirstHalf =
    firstHalfVolumes.reduce((a, b) => a + b, 0) / firstHalfVolumes.length;
  const avgSecondHalf =
    secondHalfVolumes.reduce((a, b) => a + b, 0) / secondHalfVolumes.length;

  let trendDesc = "Stable";
  let accelerationPercent = 0;
  if (avgFirstHalf > 0) {
    accelerationPercent =
      ((avgSecondHalf - avgFirstHalf) / avgFirstHalf) * 100;
    if (accelerationPercent > 20) {
      trendDesc = `Accelerating (+${accelerationPercent.toFixed(0)}% vs first half)`;
    } else if (accelerationPercent < -20) {
      trendDesc = `Decelerating (${accelerationPercent.toFixed(0)}% vs first half)`;
    } else {
      trendDesc = `Stable (${accelerationPercent.toFixed(0)}% vs first half)`;
    }
  }

  const highVolThreshold = avgVolume * 1.5;
  let highVolTotal = 0;
  let highVolLast5 = 0;
  for (let i = 0; i < volumes.length; i++) {
    if (volumes[i] > highVolThreshold) {
      highVolTotal++;
      if (i >= volumes.length - 5) {
        highVolLast5++;
      }
    }
  }

  const avgVolumeFormatted =
    avgVolume >= 1 ? avgVolume.toFixed(0) : avgVolume.toFixed(2);

  return (
    `Volume Profile (1m):\n` +
    `- Avg volume: ${avgVolumeFormatted}/candle\n` +
    `- Volume trend: ${trendDesc}\n` +
    `- High vol candles (>1.5x avg): ${highVolTotal} total, ${highVolLast5} in last 5 candles`
  );
}
