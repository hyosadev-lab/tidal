import * as readline from "node:readline/promises";
import { runAgent, type Message, type Tool } from "./agent.ts";

const tools: Record<string, Tool> = {
  get_price: {
    description: "Get the current spot price of a crypto ticker in USD",
    parameters: {
      type: "object",
      properties: { symbol: { type: "string", description: "e.g. BTC, ETH" } },
      required: ["symbol"],
    },
    run: async ({ symbol }: { symbol: string }) => {
      const res = await fetch(`https://api.coinbase.com/v2/prices/${symbol}-USD/spot`);
      const { data } = await res.json();
      return data;
    },
  },
};

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let history: Message[] | undefined;

console.log("Agent ready. Type a message (Ctrl+C or /exit to quit).");
while (true) {
  const input = (await rl.question("> ")).trim();
  if (!input) continue;
  if (input === "/exit") break;
  if (input === "/reset") {
    history = undefined;
    console.log("(history cleared)\n");
    continue;
  }

  try {
    const res = await runAgent(input, {
      tools,
      history,
      system: "You are a concise trading assistant.",
    });
    history = res.messages;
    console.log(res.text);
  } catch (e) {
    console.error(`\n! ${e instanceof Error ? e.message : e}\n`);
  }
}
rl.close();
