import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenApiClient, OpenApiError } from "../../src/gmgn/endpoint.ts";

// The 429 path, against a fake fetch. The limiter is module state, so order matters: the last
// test leaves the whole process paused for minutes.

const client = new OpenApiClient({ apiKey: "test", host: "https://gmgn.test" });
const nowUnix = () => Math.floor(Date.now() / 1000);

function serve(...replies: { status: number; body: object; reset?: number }[]) {
  let calls = 0;
  globalThis.fetch = (async () => {
    const r = replies[Math.min(calls++, replies.length - 1)]!;
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: r.reset ? { "x-ratelimit-reset": String(r.reset) } : {},
    });
  }) as typeof fetch;
  return () => calls;
}

test("a second holds at most 5 weight, counting each request as its weight + 1", async () => {
  const at: number[] = [];
  globalThis.fetch = (async () => {
    at.push(Date.now());
    return new Response(JSON.stringify({ code: 0, data: "ok" }));
  }) as typeof fetch;
  // token_info costs 1 + 1: two fit in a second (4), the third waits for the first to age out.
  await Promise.all([1, 2, 3].map(() => client.getTokenInfo("sol", "x")));
  // 500, not 200: under the parallel test run a loaded CPU alone can take 200ms. The third waits ≥1000.
  assert.ok(at[1]! - at[0]! < 500, "the second goes straight out");
  assert.ok(at[2]! - at[0]! >= 1000, "the third waits for the next second");
});

test("a read that draws a 429 with a near reset waits it out and retries once", async () => {
  const calls = serve(
    { status: 429, body: { code: 429, error: "RATE_LIMIT_EXCEEDED" }, reset: nowUnix() - 5 },
    { status: 200, body: { code: 0, data: "ok" } },
  );
  assert.equal(await client.getTokenInfo("sol", "x"), "ok");
  assert.equal(calls(), 2);
});

test("a 429 whose reset is past the retry ceiling (a ban) is thrown, not retried", async () => {
  const calls = serve({ status: 429, body: { code: 429, error: "RATE_LIMIT_BANNED" }, reset: nowUnix() + 600 });
  await assert.rejects(client.getTokenInfo("sol", "x"), (e) => e instanceof OpenApiError && e.apiError === "RATE_LIMIT_BANNED");
  assert.equal(calls(), 1);
});
