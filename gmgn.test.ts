import assert from "node:assert/strict";
import { constants, generateKeyPairSync, verify } from "node:crypto";
import { test } from "node:test";

import { signMessage, signedMessage, swap } from "./trading/gmgn.ts";

// The only tests here that need no network. The signed-message format is what the
// server verifies byte for byte, so it gets pinned; the consent gate guards real money.

test("signed message sorts keys alphabetically, not insertion order", () => {
  const msg = signedMessage("/v1/trade/query_order", { order_id: "abc", chain: "sol", client_id: "u-1", timestamp: 42 }, "", 42);
  assert.equal(msg, "/v1/trade/query_order:chain=sol&client_id=u-1&order_id=abc&timestamp=42::42");
});

test("signed message sorts array values and repeats the key", () => {
  const msg = signedMessage("/v1/x", { tag: ["b", "a"], chain: "sol" }, "", 7);
  assert.equal(msg, "/v1/x:chain=sol&tag=a&tag=b::7");
});

test("signed message percent-encodes keys and values", () => {
  const msg = signedMessage("/v1/x", { "a b": "c&d" }, "", 1);
  assert.equal(msg, "/v1/x:a%20b=c%26d::1");
});

test("signed message embeds the body verbatim for POST", () => {
  const body = JSON.stringify({ chain: "sol", input_amount: "1000" });
  assert.equal(signedMessage("/v1/trade/swap", { timestamp: 5 }, body, 5), `/v1/trade/swap:timestamp=5:${body}:5`);
});

test("swap refuses without the operator's standing consent", async () => {
  const before = process.env.GMGN_ALLOW_AUTOMATED_TRADES;
  delete process.env.GMGN_ALLOW_AUTOMATED_TRADES;
  try {
    await assert.rejects(
      swap({ chain: "sol", from: "w", inputToken: "a", outputToken: "b", amount: "1", slippage: 1 }),
      /GMGN_ALLOW_AUTOMATED_TRADES/,
    );
  } finally {
    if (before !== undefined) process.env.GMGN_ALLOW_AUTOMATED_TRADES = before;
  }
});

test("Ed25519 signature verifies against the matching public key", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const msg = signedMessage("/v1/trade/swap", { chain: "sol", timestamp: 9 }, "{}", 9);
  const sig = signMessage(msg, privateKey.export({ type: "pkcs8", format: "pem" }).toString());
  assert.ok(verify(null, Buffer.from(msg), publicKey, Buffer.from(sig, "base64")));
});

test("RSA signature verifies with PSS and a 32-byte salt", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const msg = signedMessage("/v1/trade/swap", { chain: "bsc", timestamp: 3 }, "{}", 3);
  const sig = signMessage(msg, privateKey.export({ type: "pkcs8", format: "pem" }).toString());
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
  assert.throws(
    () => signMessage("x", privateKey.export({ type: "pkcs8", format: "pem" }).toString()),
    /unsupported GMGN_PRIVATE_KEY type/,
  );
});
