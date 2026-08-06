import * as readline from "node:readline/promises";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { runAgent, type Message, type Tool } from "./src/agent/llm.ts";
import { loadSkills, skillIndex, skillTool } from "./src/agent/skills.ts";

const execAsync = promisify(exec);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let closed = false;
rl.on("close", () => (closed = true)); // Ctrl+C / EOF

const tools: Record<string, Tool> = {
  bash: {
    description: "Run a shell command and return its stdout and stderr.",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
    run: async ({ command }: { command: string }) => {
      console.log(["  $", command].join(" "));
      try {
        const { stdout, stderr } = await execAsync(command, {
          timeout: 120_000,
          maxBuffer: 32 * 1024 * 1024,
        });
        return (stdout + (stderr ? `\n[stderr]\n${stderr}` : "")).slice(0, 120_000) || "(no output)";
      } catch (e: any) {
        return `exit ${e.code ?? "?"}: ${(e.stderr || e.stdout || e.message).slice(0, 4000)}`;
      }
    },
  },
};

const skills = await loadSkills();
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
