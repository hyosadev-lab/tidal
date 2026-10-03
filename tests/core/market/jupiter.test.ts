import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { b58decode, b58encode, parseKey, signTransaction } from "../../../src/core/market/jupiter.ts";

// The signing half of the Jupiter route — everything that can be pinned without the network.
// A wrong byte here is a transaction Jupiter refuses, or a signature for the wrong wallet.

test("base58 round-trips, leading zeros included", () => {
  assert.equal(b58decode("11111111111111111111111111111111").length, 32, "the system program is 32 zero bytes");
  assert.equal(b58encode(Buffer.alloc(32)), "11111111111111111111111111111111");
  const wsol = "So11111111111111111111111111111111111111112";
  assert.equal(b58decode(wsol).length, 32);
  assert.equal(b58encode(b58decode(wsol)), wsol);
  assert.throws(() => b58decode("0OIl"), /invalid base58/);
});

/** A fresh keypair in the 64-byte seed+pubkey layout wallets export. */
function secretKey(): Buffer {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return Buffer.concat([seed, pub]);
}

test("a key is read in every form a wallet exports it, and yields its own address", () => {
  const secret = secretKey();
  const address = b58encode(secret.subarray(32));
  assert.equal(parseKey(b58encode(secret)).address, address, "base58, 64 bytes");
  assert.equal(parseKey(JSON.stringify([...secret])).address, address, "JSON byte array");
  assert.equal(parseKey(b58encode(secret.subarray(0, 32))).address, address, "bare seed");
  assert.throws(() => parseKey(b58encode(Buffer.alloc(10, 1))), /32- or 64-byte/);
});

test("signing fills this wallet's slot and no other, on v0 and legacy messages", () => {
  const w = parseKey(b58encode(secretKey()));
  const other = parseKey(b58encode(secretKey()));

  for (const versioned of [true, false]) {
    // Two required signers, ours second — the layout of an RFQ route with a market maker.
    const message = Buffer.concat([
      Buffer.from(versioned ? [0x80, 2, 0, 1, 3] : [2, 0, 1, 3]),
      other.pub,
      w.pub,
      Buffer.alloc(32, 7), // a third, non-signing account
      Buffer.alloc(40, 9), // blockhash and instructions: opaque to the signer
    ]);
    const tx = Buffer.concat([Buffer.from([2]), Buffer.alloc(128), message]);

    const signed = Buffer.from(signTransaction(tx.toString("base64"), w), "base64");
    assert.equal(signed.length, tx.length);
    assert.ok(signed.subarray(1, 65).equals(Buffer.alloc(64)), "the other signer's slot is untouched");
    assert.ok(verify(null, message, w.key, signed.subarray(65, 129)), "our slot verifies against the message");
    assert.ok(signed.subarray(129).equals(message), "the message itself is not rewritten");

    // The non-signing third account must not be mistaken for a signer.
    const stranger = parseKey(b58encode(secretKey()));
    assert.throws(() => signTransaction(tx.toString("base64"), stranger), /does not ask for this wallet/);
  }
});
