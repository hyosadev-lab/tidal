import { test } from "node:test";
import assert from "node:assert/strict";
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

test("loads every skills/<name>/SKILL.md and indexes it", async () => {
  const skills = await loadSkills();
  assert.ok(skills.length >= 7, `expected the gmgn skills, got ${skills.length}`);
  assert.ok(skills.every((s) => s.name && s.description && s.body));
  assert.match(skillIndex(skills), /- gmgn-token: Research any crypto/);
});

test("load_skill returns the body prefixed with its real directory", async () => {
  const skills = await loadSkills();
  const tool = skillTool(skills).load_skill!;

  const out = String(await tool.run({ name: "gmgn-holder-analysis" }));
  assert.match(out, /^Skill directory: .*[/\\]skills[/\\]gmgn-holder-analysis\n/);
  assert.match(out, /analyze\.py/);
  assert.equal(await tool.run({ name: "nope" }), "unknown skill: nope");
});
