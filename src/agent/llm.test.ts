import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgent, type Message } from "./llm.ts";

test("loops through a tool call and returns the final answer", async () => {
  const replies = [
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", function: { name: "add", arguments: '{"a":2,"b":3}' } }],
    },
    { role: "assistant", content: "5" },
  ];
  const seen: any[] = [];
  globalThis.fetch = (async (_url: string, init: any) => {
    seen.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ choices: [{ message: replies.shift() }] }));
  }) as any;

  const { text } = await runAgent("2+3?", {
    apiKey: "test",
    tools: {
      add: {
        description: "add",
        parameters: { type: "object", properties: {} },
        run: ({ a, b }: any) => a + b,
      },
    },
  });

  assert.equal(text, "5");
  assert.deepEqual(seen[1].messages.at(-1), {
    role: "tool",
    tool_call_id: "c1",
    content: "5",
  });
});

test("history carries the previous turn instead of re-adding the system prompt", async () => {
  let last: any;
  globalThis.fetch = (async (_url: string, init: any) => {
    last = JSON.parse(init.body);
    return new Response(
      JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }),
    );
  }) as any;

  const first = await runAgent("hi", { apiKey: "test", system: "be brief" });
  await runAgent("and again?", { apiKey: "test", system: "be brief", history: first.messages });

  assert.deepEqual(
    last.messages.map((m: Message) => m.role),
    ["system", "user", "assistant", "user"],
  );
});

test("tool errors go back to the model instead of throwing", async () => {
  const replies = [
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", function: { name: "boom", arguments: "{}" } }],
    },
    { role: "assistant", content: "recovered" },
  ];
  let last: any;
  globalThis.fetch = (async (_url: string, init: any) => {
    last = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: replies.shift() }] }));
  }) as any;

  const { text } = await runAgent("go", {
    apiKey: "test",
    tools: {
      boom: {
        description: "boom",
        parameters: {},
        run: () => {
          throw new Error("nope");
        },
      },
    },
  });

  assert.equal(text, "recovered");
  assert.equal(last.messages.at(-1).content, "error: nope");
});
