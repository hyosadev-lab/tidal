import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJson, skillBlock } from "../../src/core/analyst.ts";

// The model answers in prose around its JSON often enough that recovering the object is
// part of the contract, not a nicety.

// ── model output parsing ──────────────────────────────────────────────

test("a decision is recovered from a fenced, chatty reply", () => {
  const d = extractJson(
    'Here you go:\n```json\n{"entries":[{"address":"abc","conviction":72,"thesis":"x"}],"exits":[],"recheck":[{"address":"abc","minutes":4}],"notes":"quiet"}\n```\nHope that helps.',
  );
  assert.equal(d?.entries.length, 1);
  assert.equal(d?.notes, "quiet");
  assert.equal(d?.recheck[0]?.minutes, 4);
});

test("garbage in the model reply yields no decision rather than a bad one", () => {
  assert.equal(extractJson("no json here at all"), null);
});

test("skillBlock is empty without skills and names each layer with one", () => {
  assert.equal(skillBlock([]), "");
  const b = skillBlock([{ name: "token-dd", body: "read flow first" }]);
  assert.match(b, /SKILLS/);
  assert.match(b, /--- skill: token-dd ---\nread flow first/);
});
