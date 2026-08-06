import { OpenApiClient } from "./endpoint.ts";

export { OpenApiClient, OpenApiError } from "./endpoint.ts";
export type * from "./endpoint.ts";

const HOST = "https://openapi.gmgn.ai";

let client: OpenApiClient | null = null;

/**
 * Singleton GMGN OpenAPI client, built from GMGN_API_KEY / GMGN_PRIVATE_KEY in the
 * environment (see .env.example). Signed routes (swap, query_order, wallet_holdings,
 * follow_wallet) throw at call time if GMGN_PRIVATE_KEY wasn't set — this just wires
 * env vars into the client the way trading/gmgn.ts already does, doesn't duplicate it.
 */
export function gmgnClient(): OpenApiClient {
  if (client) return client;

  const apiKey = process.env.GMGN_API_KEY?.trim();
  if (!apiKey) throw new Error("GMGN_API_KEY is missing — set it in .env");

  const rawPem = process.env.GMGN_PRIVATE_KEY?.trim();
  const privateKeyPem = rawPem ? rawPem.replace(/\\n/g, "\n") : undefined;

  client = new OpenApiClient({ apiKey, privateKeyPem, host: HOST });
  return client;
}
