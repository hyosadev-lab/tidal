import { calculateVolumeDeltas } from "./kline";

describe("kline utils", () => {
  test("calculateVolumeDeltas returns formatted string with deltas", () => {
    const klines = [
      [1, 2, 3, 4, 100],  // [open, high, low, close, volume]
      [1, 2, 3, 4, 200],
      [1, 2, 3, 4, 150],
    ];
    const result = calculateVolumeDeltas(klines, 3);
    expect(result).toContain("+100.0%");
    expect(result).toContain("-25.0%");
  });

  test("calculateVolumeDeltas handles single candle", () => {
    const klines = [[1, 2, 3, 4, 100]];  // [open, high, low, close, volume]
    const result = calculateVolumeDeltas(klines, 1);
    expect(result).toContain("N/A");
  });
});
