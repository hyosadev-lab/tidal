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
