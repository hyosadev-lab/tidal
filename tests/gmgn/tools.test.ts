import { test } from "node:test";
import assert from "node:assert/strict";

process.env.GMGN_API_KEY ||= "test";
const { tools } = await import("../../src/gmgn/tools.ts");

const seen: URL[] = [];
const replies: Record<string, unknown> = {
  "/v1/market/token_kline": { list: [{ time: 1, open: "1", close: "1", high: "1", low: "1", volume: "5", amount: "5" }] },
  "/v1/market/token_top_holders": {
    list: [{ address: "W", amount_percentage: 0.05, history_bought_fee: 3, native_transfer: { name: null, from_address: "F", amount: "85", tx_hash: "T" } }],
  },
  "/v1/user/created_tokens": {
    inner_count: 3, open_count: 1, open_ratio: "0.33", last_create_timestamp: 9,
    creator_ath_info: { ath_token: "A", token_symbol: "S", ath_mc: "1", token_logo: "L" },
    tokens: Array.from({ length: 101 }, (_, i) => ({ token_address: `T${i}`, logo: "L", is_open: false })),
  },
};
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  seen.push(url);
  return new Response(JSON.stringify({ code: 0, data: replies[url.pathname] }));
}) as typeof fetch;

test("tools: clamp what the model asks for, send sol, cut rows to the listed fields", async () => {
  const before = Date.now();
  assert.equal((await tools.gmgn_token_kline!.run({ address: "M", resolution: "5m", limit: 9999 }) as unknown[]).length, 1);
  const k = seen.at(-1)!.searchParams;
  assert.equal(k.get("chain"), "sol");
  const span = Number(k.get("to")) - Number(k.get("from"));
  assert.equal(span, 100 * 300_000, "100 candles max, in milliseconds");
  assert.ok(Number(k.get("to")) >= before);

  const [w] = (await tools.gmgn_token_top_holders!.run({ address: "M", limit: 0, tag: "sniper" })) as any[];
  const h = seen.at(-1)!.searchParams;
  assert.deepEqual([h.get("limit"), h.get("order_by"), h.get("tag")], ["10", "amount_percentage", "sniper"]);
  assert.deepEqual(w, { address: "W", amount_percentage: 0.05, native_transfer: { name: null, from_address: "F", amount: "85" } });

  const c = (await tools.gmgn_created_tokens!.run({ wallet: "D", limit: 3 })) as any;
  assert.equal(seen.at(-1)!.searchParams.get("order_by"), null, "no order_by = GMGN's newest first");
  assert.deepEqual(c.creator_ath_info, { ath_token: "A", token_symbol: "S", ath_mc: "1" });
  assert.deepEqual(c.tokens, [
    { token_address: "T0", is_open: false },
    { token_address: "T1", is_open: false },
    { token_address: "T2", is_open: false },
  ]);
});
