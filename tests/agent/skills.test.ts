import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadSkills } from "../../src/agent/skills.ts";

test("loadSkills reads every skills/<name>/SKILL.md, skipping empty and missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "tta-skills-"));
  for (const [name, text] of Object.entries({ b: "second", a: "first\n", empty: "  " })) {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, "SKILL.md"), text);
  }
  mkdirSync(join(dir, "no-file"));
  assert.deepEqual(loadSkills(pathToFileURL(dir + "/")), [
    { name: "a", body: "first" },
    { name: "b", body: "second" },
  ]);
  assert.deepEqual(loadSkills(pathToFileURL(join(dir, "missing") + "/")), []);
});
