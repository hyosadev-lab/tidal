import { readdirSync, readFileSync } from "node:fs";

const SKILLS_DIR = new URL("../../skills/", import.meta.url);

export interface Skill {
  name: string;
  body: string;
}

/** Every `skills/<name>/SKILL.md`, read fresh each cycle so an edit lands without a restart. */
export function loadSkills(dir: URL = SKILLS_DIR): Skill[] {
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    try {
      const body = readFileSync(new URL(`${name}/SKILL.md`, dir), "utf8").trim();
      return body ? [{ name, body }] : [];
    } catch {
      return [];
    }
  });
}
