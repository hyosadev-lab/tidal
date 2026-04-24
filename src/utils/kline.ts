/**
 * Parse kline JSON string to array
 */
export function parseKlineData(klineString: string): number[][] {
  if (!klineString) return [];
  try {
    const parsed = JSON.parse(klineString);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Calculate volume deltas for last N candles
 * Returns formatted string: "Volume Deltas: +100%, -25%, +50%"
 */
export function calculateVolumeDeltas(klines: number[][], limit: number): string {
  if (klines.length < 2) {
    return "Volume Deltas: N/A (insufficient data)";
  }

  const deltas: string[] = [];
  const startIdx = Math.max(0, klines.length - limit);

  for (let i = startIdx + 1; i < klines.length; i++) {
    const prevVolume = klines[i - 1][5]; // volume is at index 5
    const currVolume = klines[i][5];

    if (prevVolume === 0) {
      deltas.push("N/A");
      continue;
    }

    const deltaPercent = ((currVolume - prevVolume) / prevVolume) * 100;
    const sign = deltaPercent >= 0 ? "+" : "";
    deltas.push(`${sign}${deltaPercent.toFixed(1)}%`);
  }

  return `Volume Deltas (${limit} candles): ${deltas.join(", ")}`;
}

/**
 * Get volume deltas from kline JSON string
 */
export function getVolumeDeltasFromKline(klineString: string, limit: number = 5): string {
  const klines = parseKlineData(klineString);
  return calculateVolumeDeltas(klines, limit);
}
