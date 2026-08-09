import assert from "node:assert/strict";
import { constants, generateKeyPairSync, verify } from "node:crypto";
import { test } from "node:test";

import { buildMessage, detectAlgorithm, sign } from "./signer.ts";
import { gmgnClient } from "./client.ts";
import { OpenApiClient } from "./endpoint.ts";

// Pure, no network — pins the exact byte format GMGN verifies the signature against.

test("message sorts keys alphabetically, not insertion order", () => {
  const msg = buildMessage("/v1/trade/query_order", { order_id: "abc", chain: "sol", client_id: "u-1", timestamp: 42 }, "", 42);
  assert.equal(msg, "/v1/trade/query_order:chain=sol&client_id=u-1&order_id=abc&timestamp=42::42");
});

test("message sorts array values and repeats the key", () => {
  const msg = buildMessage("/v1/x", { tag: ["b", "a"], chain: "sol" }, "", 7);
  assert.equal(msg, "/v1/x:chain=sol&tag=a&tag=b::7");
});

test("message percent-encodes keys and values", () => {
  const msg = buildMessage("/v1/x", { "a b": "c&d" }, "", 1);
  assert.equal(msg, "/v1/x:a%20b=c%26d::1");
});

test("message embeds the body verbatim for POST", () => {
  const body = JSON.stringify({ chain: "sol", input_amount: "1000" });
  assert.equal(buildMessage("/v1/trade/swap", { timestamp: 5 }, body, 5), `/v1/trade/swap:timestamp=5:${body}:5`);
});

test("Ed25519 signature verifies against the matching public key", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const msg = buildMessage("/v1/trade/swap", { chain: "sol", timestamp: 9 }, "{}", 9);
  const sig = sign(msg, pem, detectAlgorithm(pem));
  assert.ok(verify(null, Buffer.from(msg), publicKey, Buffer.from(sig, "base64")));
});

test("RSA signature verifies with PSS and a 32-byte salt", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const msg = buildMessage("/v1/trade/swap", { chain: "bsc", timestamp: 3 }, "{}", 3);
  const sig = sign(msg, pem, detectAlgorithm(pem));
  const ok = verify(
    "sha256",
    Buffer.from(msg),
    { key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 },
    Buffer.from(sig, "base64"),
  );
  assert.ok(ok);
});

test("an unsupported key type is refused, not silently mis-signed", () => {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  assert.throws(() => detectAlgorithm(pem), /Unsupported key type/);
});

test("swap refuses without the operator's standing consent", async () => {
  const before = process.env.GMGN_ALLOW_AUTOMATED_TRADES;
  delete process.env.GMGN_ALLOW_AUTOMATED_TRADES;
  const client = new OpenApiClient({ apiKey: "test", host: "https://openapi.gmgn.ai" });
  try {
    // Refused before the request is even built, so this makes no network call.
    await assert.rejects(
      client.swap({ chain: "sol", from_address: "w", input_token: "a", output_token: "b", input_amount: "1", slippage: 1 }),
      /GMGN_ALLOW_AUTOMATED_TRADES/,
    );
  } finally {
    if (before !== undefined) process.env.GMGN_ALLOW_AUTOMATED_TRADES = before;
  }
});

test("gmgnClient refuses without GMGN_API_KEY", () => {
  const before = process.env.GMGN_API_KEY;
  delete process.env.GMGN_API_KEY;
  try {
    // reach past the module-level singleton by re-importing isn't worth it here;
    // this only holds when no client has been built yet in this process.
    assert.throws(() => gmgnClient(), /GMGN_API_KEY/);
  } finally {
    if (before !== undefined) process.env.GMGN_API_KEY = before;
  }
});
