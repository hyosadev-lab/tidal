import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, sanitize } from "../src/config.ts";
import { parseVerdicts } from "../src/decide.ts";

const now = 1_000_000;
const due = ["A", "B", "C"];

test("verdicts: unknown tokens dropped, left-out tokens wait, minutes clamped, fences tolerated", () => {
  const text =
    "```json\n" +
    JSON.stringify({
      verdicts: [
        { address: "A", action: "buy", conviction: 140, thesis: "flow" },
        { address: "B", action: "wait", recheck_minutes: 999 },
        { address: "Z", action: "buy" },
      ],
    }) +
    "\n``` trailing words";
  const v = parseVerdicts(text, due, DEFAULTS, now)!;
  assert.deepEqual(
    v.map((x) => [x.token, x.action, x.conviction, x.recheckAt]),
    [
      ["A", "buy", 100, null],
      ["B", "wait", null, now + 60 * 60_000],
      ["C", "wait", null, now + 15 * 60_000],
    ],
  );
  assert.equal(parseVerdicts("no json here", due, DEFAULTS, now), null);
});

test("agent exit plans: clamped into the operator's range, or null when they do not sell 100%", () => {
  const cfg = sanitize({ exitMode: "agent" });
  const plan = (exit_plan: unknown) =>
    parseVerdicts(JSON.stringify({ verdicts: [{ address: "A", action: "buy", exit_plan }] }), ["A"], cfg, now)![0]!.plan;
  assert.deepEqual(plan({ sl: -70, tps: [{ at: 5, sell: 50 }, { at: 100, sell: 50 }] }), [
    { kind: "sl", at: -40, sell: 100 },
    { kind: "tp", at: 20, sell: 50 },
    { kind: "tp", at: 100, sell: 50 },
  ]);
  assert.equal(plan({ sl: -20, tps: [{ at: 50, sell: 60 }] }), null);
  assert.equal(plan(undefined), null);
});

test("config: a fixed plan that does not exit fully falls back to the default", () => {
  assert.deepEqual(sanitize({ plan: [{ kind: "tp", at: 50, sell: 90 }, { kind: "sl", at: -20, sell: 100 }] }).plan, DEFAULTS.plan);
  assert.equal(sanitize({ maxOpenPositions: 999, mode: "yolo" }).maxOpenPositions, 20);
  assert.equal(sanitize({ mode: "yolo" }).mode, "paper");
});
