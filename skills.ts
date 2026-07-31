import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Tool } from "./agent.ts";

export type Skill = { name: string; description: string; body: string; dir: string };

// ponytail: flat `key: value` frontmatter only — swap in a YAML parser if skills ever need lists/nesting
export function parseSkill(md: string, fallbackName: string, dir = ""): Skill {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
  const meta = new Map<string, string>();
  for (const line of fm?.[1]?.split(/\r?\n/) ?? []) {
    const i = line.indexOf(":");
    if (i > 0) meta.set(line.slice(0, i).trim(), line.slice(i + 1).trim().replace(/^["']|["']$/g, ""));
  }
  return {
    name: meta.get("name") ?? fallbackName,
    description: meta.get("description") ?? "",
    body: (fm ? md.slice(fm[0].length) : md).trim(),
    dir,
  };
}

/** Reads `skills/<name>/SKILL.md`. Missing directory, or a folder without SKILL.md, = skipped. */
export async function loadSkills(root = "skills"): Promise<Skill[]> {
  let names: string[];
  try {
    names = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  const skills = await Promise.all(
    names.map(async (name) => {
      const dir = resolve(root, name);
      try {
        return parseSkill(await readFile(join(dir, "SKILL.md"), "utf8"), name, dir);
      } catch {
        return null;
      }
    }),
  );
  return skills.filter((s): s is Skill => s !== null);
}

/** System-prompt suffix listing what's available, so the model knows what it can load. */
export function skillIndex(skills: Skill[]) {
  if (!skills.length) return "";
  return `\n\nSkills available — call load_skill and follow its instructions before doing a task it covers:\n${skills
    .map((s) => `- ${s.name}: ${s.description}`)
    .join("\n")}`;
}

export function skillTool(skills: Skill[]): Record<string, Tool> {
  if (!skills.length) return {};
  return {
    load_skill: {
      description: "Load the full instructions for one of the available skills.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", enum: skills.map((s) => s.name) } },
        required: ["name"],
      },
      run: ({ name }: { name: string }) => {
        const skill = skills.find((s) => s.name === name);
        if (!skill) return `unknown skill: ${name}`;
        // Skills are written for other agents and may hardcode install paths; point at the real one.
        return `Skill directory: ${skill.dir}\nResolve every file path in these instructions against it, ignoring any other install path they mention.\n\n${skill.body}`;
      },
    },
  };
}
