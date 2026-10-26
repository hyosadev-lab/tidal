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
  /** Any OpenAI-compatible chat completions base URL. Default OpenRouter. */
  baseUrl?: string;
  model?: string;
  system?: string;
  tools?: Record<string, Tool>;
  maxSteps?: number;
  apiKey?: string;
  /** Previous `messages` from an earlier run, to continue the conversation. */
  history?: Message[];
  /** Called after each tool call, for logging. Must not throw. */
  onTool?: (name: string, args: unknown, result: unknown) => void;
};

/** Tokens billed over a whole run, summed across steps. */
export type Usage = { input: number; output: number };

async function complete(messages: Message[], o: AgentOptions, usage: Usage) {
  const tools = Object.entries(o.tools ?? {}).map(([name, t]) => ({
    type: "function",
    function: { name, description: t.description, parameters: t.parameters },
  }));
  const res = await fetch(`${o.baseUrl ?? process.env.LLM_BASE_URL ?? "https://openrouter.ai/api/v1"}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${o.apiKey ?? process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: o.model ?? process.env.OPENROUTER_MODEL ?? "anthropic/claude-sonnet-4.5",
      messages,
      // Omitted when empty: some providers reject `tools: []`.
      ...(tools.length ? { tools } : {}),
    }),
  });
  if (!res.ok) throw new Error(`llm ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.error) throw new Error(`llm: ${json.error.message}`);
  usage.input += json.usage?.prompt_tokens ?? 0;
  usage.output += json.usage?.completion_tokens ?? 0;
  const choice = json.choices[0];
  // An empty answer with no tool call is a failure with a cause — usually the output limit,
  // spent on reasoning. Say which, instead of handing back "" to be reported as bad JSON.
  if (!choice.message.content && !choice.message.tool_calls?.length)
    throw new Error(`llm: empty reply (finish_reason: ${choice.finish_reason ?? "none"}, output tokens: ${json.usage?.completion_tokens ?? "?"})`);
  return choice.message as Message;
}

/**
 * Runs the tool-calling loop until the model answers without tool calls. A thrown error carries
 * `messages` and `usage` too: the transcript of a failed run is its audit trail.
 */
export async function runAgent(prompt: string, o: AgentOptions = {}) {
  const messages: Message[] = [
    ...(o.history?.length
      ? o.history
      : o.system
        ? ([{ role: "system", content: o.system }] as Message[])
        : []),
    { role: "user", content: prompt },
  ];
  const usage: Usage = { input: 0, output: 0 };
  try {
    return await loop(messages, o, usage);
  } catch (e) {
    throw Object.assign(e instanceof Error ? e : new Error(String(e)), { messages, usage });
  }
}

async function loop(messages: Message[], o: AgentOptions, usage: Usage) {
  for (let step = 0; step < (o.maxSteps ?? 10); step++) {
    const msg = await complete(messages, o, usage);
    messages.push(msg);
    if (!msg.tool_calls?.length) return { text: msg.content ?? "", messages, usage };

    for (const call of msg.tool_calls) {
      const tool = o.tools?.[call.function.name];
      let args: unknown;
      let result: unknown;
      try {
        args = JSON.parse(call.function.arguments);
        result = tool ? await tool.run(args) : `unknown tool: ${call.function.name}`;
      } catch (e) {
        result = `error: ${e instanceof Error ? e.message : String(e)}`;
      }
      o.onTool?.(call.function.name, args, result);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: typeof result === "string" ? result : JSON.stringify(result),
      });
    }
  }
  throw new Error("maxSteps exceeded");
}

/** Wraps `tools` so the whole set shares `max` calls; past that a call returns a refusal string, not an error. */
export function budgetedTools(tools: Record<string, Tool>, max: number): Record<string, Tool> {
  let left = max;
  return Object.fromEntries(
    Object.entries(tools).map(([name, t]) => [
      name,
      { ...t, run: (a: any) => (left-- > 0 ? t.run(a) : `tool budget spent (${max} per run) — answer with what you have.`) },
    ]),
  );
}
