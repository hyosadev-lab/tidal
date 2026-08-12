import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkills, parseSkill, skillIndex, skillTool } from "./skills.ts";

test("parses frontmatter and strips it from the body", () => {
  const s = parseSkill(`---\nname: foo\ndescription: does "foo" things\n---\n\n# Foo\nstep one\n`, "dirname");
  assert.equal(s.name, "foo");
  assert.equal(s.description, 'does "foo" things');
  assert.equal(s.body, "# Foo\nstep one");
});

test("falls back to the directory name when frontmatter is missing", () => {
  const s = parseSkill("just a body", "bar", "/tmp/bar");
  assert.deepEqual(s, { name: "bar", description: "", body: "just a body", dir: "/tmp/bar" });
});

test("missing skills directory yields no skills and no tool", async () => {
  const skills = await loadSkills("does-not-exist");
  assert.deepEqual(skills, []);
  assert.deepEqual(skillTool(skills), {});
  assert.equal(skillIndex(skills), "");
});

// Against a temp root, not the repo: nothing loads this module any more (the CLI that did is
// gone), so there is no `skills/` directory left to read. The loader is kept for the day one
// comes back — see src/agent/tools.ts, same reasoning.
test("loads <root>/<name>/SKILL.md, indexes it, and skips folders without one", async () => {
  const root = await mkdtemp(join(tmpdir(), "tta-skills-"));
  await mkdir(join(root, "demo"));
  await writeFile(join(root, "demo", "SKILL.md"), "---\nname: demo\ndescription: does demo things\n---\n\nstep one\n");
  await mkdir(join(root, "empty-dir"));

  const skills = await loadSkills(root);
  assert.deepEqual(skills.map((s) => s.name), ["demo"]);
  assert.match(skillIndex(skills), /- demo: does demo things/);

  const tool = skillTool(skills).load_skill!;
  const out = String(await tool.run({ name: "demo" }));
  assert.match(out, /^Skill directory: .*[/\\]demo\n/);
  assert.match(out, /step one$/);
  assert.equal(await tool.run({ name: "nope" }), "unknown skill: nope");

  await rm(root, { recursive: true, force: true });
});
