import { test } from "node:test";
import assert from "node:assert/strict";
import { poolPrice, poolRef, virtualQuote } from "../../../src/core/market/helius.ts";

const WSOL = "So11111111111111111111111111111111111111112";
const pool = { exchange: "pump_amm", quote_address: WSOL, pool_address: "P", base_vault_address: "B", quote_vault_address: "Q" };

test("only a SOL-quoted pump_amm pool with both vaults can be streamed", () => {
  assert.deepEqual(poolRef({ pool }), { pool: "P", baseVault: "B", quoteVault: "Q" });
  // APU on the server's list: pump_amm, but quoted in PUMP — dividing by SOL would be a wrong price.
  assert.equal(poolRef({ pool: { ...pool, quote_address: "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn" } }), null);
  assert.equal(poolRef({ pool: { ...pool, exchange: "raydium_clmm" } }), null);
  assert.equal(poolRef({ pool: { ...pool, base_vault_address: "" } }), null);
  assert.equal(poolRef(null), null);
});

test("a pump_amm price is the vault ratio plus the pool's virtual quote reserve", () => {
  // CYBERTRUCK's pool account as read off the chain: 301 bytes, the reserve at byte 245.
  const data = Buffer.alloc(301);
  data.writeBigUInt64LE(17_576_112_412n, 245);
  const virtual = virtualQuote(data.toString("base64"));
  assert.equal(virtual, 17.576112412);
  assert.equal(virtualQuote(Buffer.alloc(211).toString("base64")), null, "an older, shorter layout is not guessed at");
  assert.equal(virtualQuote(undefined), null);

  // Its vaults at that moment, SOL at $120.66: GMGN said $0.00021046, the bare ratio $0.00018991.
  const usd = poolPrice(105_174_838, 165.96, virtual!) * 120.66;
  assert.ok(Math.abs(usd / 0.00021046 - 1) < 0.01, `got ${usd}`);
  assert.equal(poolPrice(0, 1, 1), 0);
});
