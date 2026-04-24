/**
 * Parse kline string to array
 * Supports both JSON format and GMGN string format
 * GMGN format: "O:1.0 H:1.1 L:0.9 C:1.05 V:1000"
 */
export function parseKlineData(klineString: string): number[][] {
  if (!klineString) return [];

  // Try JSON format first
  try {
    const parsed = JSON.parse(klineString);
    if (Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // Not JSON, try GMGN string format
  }

  // Parse GMGN string format
  const lines = klineString.split("\n").filter(line => line.trim());
  const candles: number[][] = [];

  for (const line of lines) {
    // Parse format: "O:1.0 H:1.1 L:0.9 C:1.05 V:1000"
    const openMatch = line.match(/O:([0-9.]+)/);
    const highMatch = line.match(/H:([0-9.]+)/);
    const lowMatch = line.match(/L:([0-9.]+)/);
    const closeMatch = line.match(/C:([0-9.]+)/);
    const volumeMatch = line.match(/V:([0-9.]+)/);

    if (openMatch && highMatch && lowMatch && closeMatch && volumeMatch) {
      const candle: number[] = [
        0, // timestamp (not available in string format)
        parseFloat(openMatch[1] || "0"),
        parseFloat(highMatch[1] || "0"),
        parseFloat(lowMatch[1] || "0"),
        parseFloat(closeMatch[1] || "0"),
        parseFloat(volumeMatch[1] || "0")
      ];
      candles.push(candle);
    }
  }

  return candles;
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
    const prevKline = klines[i - 1];
    const currKline = klines[i];

    if (!prevKline || !currKline) continue; // Safety check

    const prevVolume = prevKline[5]; // volume is at index 5
    const currVolume = currKline[5];

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
 * Get volume deltas from kline JSON string
 */
export function getVolumeDeltasFromKline(klineString: string, limit: number = 5): string {
  const klines = parseKlineData(klineString);
  return calculateVolumeDeltas(klines, limit);
}
