export type Tool = {
  description: string;
  parameters: object; // JSON Schema
  run: (args: any) => Promise<unknown> | unknown;
};

export type Message = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
};

export type AgentOptions = {
  model?: string;
  system?: string;
  tools?: Record<string, Tool>;
  maxSteps?: number;
  apiKey?: string;
  /** Previous `messages` from an earlier run, to continue the conversation. */
  history?: Message[];
};

async function complete(messages: Message[], o: AgentOptions) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${o.apiKey ?? process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: o.model ?? process.env.OPENROUTER_MODEL ?? "anthropic/claude-sonnet-4.5",
      messages,
      tools: Object.entries(o.tools ?? {}).map(([name, t]) => ({
        type: "function",
        function: { name, description: t.description, parameters: t.parameters },
      })),
    }),
  });
  if (!res.ok) throw new Error(`openrouter ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.error) throw new Error(`openrouter: ${json.error.message}`);
  return json.choices[0].message as Message;
}

/** Runs the tool-calling loop until the model answers without tool calls. */
export async function runAgent(prompt: string, o: AgentOptions = {}) {
  const messages: Message[] = [
    ...(o.history?.length
      ? o.history
      : o.system
        ? ([{ role: "system", content: o.system }] as Message[])
        : []),
    { role: "user", content: prompt },
  ];

  for (let step = 0; step < (o.maxSteps ?? 10); step++) {
    const msg = await complete(messages, o);
    messages.push(msg);
    if (!msg.tool_calls?.length) return { text: msg.content ?? "", messages };

    for (const call of msg.tool_calls) {
      const tool = o.tools?.[call.function.name];
      let result: unknown;
      try {
        result = tool
          ? await tool.run(JSON.parse(call.function.arguments))
          : `unknown tool: ${call.function.name}`;
      } catch (e) {
        result = `error: ${e instanceof Error ? e.message : String(e)}`;
      }
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: typeof result === "string" ? result : JSON.stringify(result),
      });
    }
  }
  throw new Error("maxSteps exceeded");
}
