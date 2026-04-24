import { calculateVolumeDeltas, parseKlineData } from "./kline";

describe("kline utils", () => {
  test("parseKlineData parses JSON string to array", () => {
    const klineString = JSON.stringify([[1700000000, 1, 2, 3, 4, 100]]);
    const result = parseKlineData(klineString);
    expect(result).toEqual([[1700000000, 1, 2, 3, 4, 100]]);
  });

  test("parseKlineData handles empty string", () => {
    const result = parseKlineData("");
    expect(result).toEqual([]);
  });

  test("calculateVolumeDeltas returns formatted string with deltas", () => {
    const klines = [
      [1700000000, 1, 2, 3, 4, 100],
      [1700000060, 1, 2, 3, 4, 200],
      [1700000120, 1, 2, 3, 4, 150],
    ];
    const result = calculateVolumeDeltas(klines, 3);
    expect(result).toContain("+100.0%");
    expect(result).toContain("-25.0%");
  });

  test("calculateVolumeDeltas handles single candle", () => {
    const klines = [[1700000000, 1, 2, 3, 4, 100]];
    const result = calculateVolumeDeltas(klines, 1);
    expect(result).toContain("N/A");
  });
});
