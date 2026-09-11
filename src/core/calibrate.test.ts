import { test } from "node:test";
import assert from "node:assert/strict";
import { bands, median, spearman } from "./calibrate.ts";
import { score } from "./domain/gates.ts";

// The report is only worth acting on if the maths under it is right — a sign error here
// would argue for inverting a weight that is fine.

test("spearman ranks monotonically, ignores scale, and survives ties", () => {
  const xs = [1, 2, 3, 4, 5];
  assert.equal(spearman(xs, [10, 20, 30, 40, 50]), 1);
  assert.equal(spearman(xs, [50, 40, 30, 20, 10]), -1);
  // Rank correlation, not Pearson: one huge outlier must not decide the answer.
  assert.equal(spearman(xs, [1, 2, 3, 4, 900]), 1);
  assert.equal(spearman(xs, [7, 7, 7, 7, 7]), 0, "a constant column correlates with nothing");
  assert.equal(spearman([1, 2], [1, 2]), 0, "too few rows to claim anything");
  assert.ok(Math.abs(spearman([1, 1, 2, 2, 3], [1, 2, 2, 3, 3])) < 1, "tied ranks are averaged");
});

test("bands bucket by score and describe what each bucket returned", () => {
  const rows = [
    { score: 5, ret: -0.5 },
    { score: 19, ret: -0.1 },
    { score: 20, ret: 0.1 },
    { score: 85, ret: 0.3 },
    { score: 95, ret: 1.0 },
  ];
  const b = bands(rows);
  assert.deepEqual(b.map((x) => x.n), [2, 1, 0, 0, 2], "edges are half-open: 19 is low, 20 is not");
  assert.equal(b[0]!.median, -0.3);
  assert.equal(b[0]!.winRate, 0);
  assert.equal(b[4]!.winRate, 1);
  assert.equal(b[4]!.bigWinRate, 1, "both cleared +20%");
  assert.equal(median([]), 0, "no rows is 0, not NaN");
});
