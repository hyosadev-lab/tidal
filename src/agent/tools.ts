import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Tool } from "./llm.ts";
import { gmgnTools } from "./gmgn-tools.ts";

const execAsync = promisify(exec);

export const tools: Record<string, Tool> = {
  ...gmgnTools,
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
