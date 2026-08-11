import * as readline from "node:readline/promises";
import { runAgent, type Message } from "./agent/llm.ts";
import { loadSkills, skillIndex, skillTool } from "./agent/skills.ts";
import { tools } from "./agent/tools.ts";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let closed = false;
rl.on("close", () => (closed = true)); // Ctrl+C / EOF

const skills = await loadSkills(new URL("../skills", import.meta.url).pathname);
Object.assign(tools, skillTool(skills));
const system =
  "You are a concise crypto trading assistant. You have a bash tool; the skills below tell you which commands to run." +
  skillIndex(skills);

let history: Message[] | undefined;

console.log(
  `Agent ready — skills: ${skills.map((s) => s.name).join(", ") || "none"}\nType a message (Ctrl+C or /exit to quit).`,
);
while (!closed) {
  const input = ((await rl.question("> ")) ?? "").trim();
  if (closed || input === "/exit") break;
  if (!input) continue;
  if (input === "/reset") {
    history = undefined;
    console.log("(history cleared)\n");
    continue;
  }

  try {
    const res = await runAgent(input, { tools, history, system, maxSteps: 25 });
    history = res.messages;
    console.log(res.text);
  } catch (e) {
    console.error(`\n! ${e instanceof Error ? e.message : e}\n`);
  }
}
rl.close();
