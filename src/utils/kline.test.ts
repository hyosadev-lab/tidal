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

  test("parseKlineData parses GMGN string format", () => {
    const klineString = "O:1.0 H:1.1 L:0.9 C:1.05 V:1000\nO:1.05 H:1.2 L:1.0 C:1.15 V:2000";
    const result = parseKlineData(klineString);
    expect(result).toEqual([
      [0, 1.0, 1.1, 0.9, 1.05, 1000],
      [0, 1.05, 1.2, 1.0, 1.15, 2000]
    ]);
  });

  test("parseKlineData handles mixed format (tries JSON first, then string)", () => {
    const jsonString = JSON.stringify([[1700000000, 1, 2, 3, 4, 100]]);
    const result = parseKlineData(jsonString);
    expect(result).toEqual([[1700000000, 1, 2, 3, 4, 100]]);
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
