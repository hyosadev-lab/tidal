import * as crypto from "node:crypto";

// Ported from gmgn-skills/src/client/signer.ts — request signing for GMGN OpenAPI's
// "signed" auth mode (swap, query_order). Trimmed: no loadPrivateKey/file support,
// the key comes from GMGN_PRIVATE_KEY (see index.ts), not a path on disk.

export type SignAlgorithm = "Ed25519" | "RSA-SHA256";

/** Detect signing algorithm from a PEM private key. */
export function detectAlgorithm(pem: string): SignAlgorithm {
  const key = crypto.createPrivateKey(pem);
  switch (key.asymmetricKeyType) {
    case "ed25519":
      return "Ed25519";
    case "rsa":
      return "RSA-SHA256";
    default:
      throw new Error(`Unsupported key type: ${key.asymmetricKeyType}. Supported: Ed25519, RSA`);
  }
}

/**
 * Build auth query params (timestamp + client_id).
 * timestamp: Unix seconds, server validates within ±5s.
 * client_id: UUID, replays rejected within 7s.
 */
export function buildAuthQuery(): { timestamp: number; client_id: string } {
  return {
    timestamp: Math.floor(Date.now() / 1000),
    client_id: crypto.randomUUID(),
  };
}

/**
 * Build the signature message (signed auth).
 * Format: {sub_path}:{sorted_query_string}:{request_body}:{timestamp}
 * sorted_query_string: all query params (including timestamp, client_id) sorted alphabetically
 * by key. Array values are serialized as repeated k=v pairs (same as buildUrl), sorted by value.
 */
export function buildMessage(
  subPath: string,
  queryParams: Record<string, string | number | string[]>,
  body: string,
  timestamp: number,
): string {
  const sortedQs = Object.keys(queryParams)
    .sort()
    .flatMap((k) => {
      const ek = encodeURIComponent(k);
      const v = queryParams[k];
      if (Array.isArray(v)) return [...v].sort().map((item) => `${ek}=${encodeURIComponent(item)}`);
      return [`${ek}=${encodeURIComponent(String(v))}`];
    })
    .join("&");
  return `${subPath}:${sortedQs}:${body}:${timestamp}`;
}

/**
 * Sign a message and return the base64-encoded signature.
 * Ed25519: signs raw message bytes (no hashing).
 * RSA-SHA256: RSA-PSS + SHA256, salt length = 32 (matches server-side rsa.VerifyPSS nil opts).
 */
export function sign(message: string, privateKeyPem: string, algorithm: SignAlgorithm): string {
  const msgBuf = Buffer.from(message, "utf-8");

  if (algorithm === "Ed25519") return crypto.sign(null, msgBuf, privateKeyPem).toString("base64");

  return crypto
    .sign("sha256", msgBuf, {
      key: privateKeyPem,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32,
    })
    .toString("base64");
}
