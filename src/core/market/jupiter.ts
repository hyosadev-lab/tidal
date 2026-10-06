import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { short } from "../domain/num.ts";

/**
 * Jupiter Swap V2 — the Solana execution route, and the cast boundary for it the way `gmgn.ts`
 * is for GMGN: nothing outside this file speaks to Jupiter or to a Solana RPC.
 *
 * Unlike a GMGN swap, nothing here is custodial. `/order` hands back an unsigned transaction,
 * this process signs it with the wallet's own key (`SOLANA_PRIVATE_KEY`) and `/execute` lands
 * it. So that key in the environment is the whole barrier between this process and the wallet:
 * there is no `GMGN_ALLOW_AUTOMATED_TRADES` check on this path — the operator's decision.
 *
 * Jupiter is the swap and nothing more. Take-profit and stop-loss used to be parked as Trigger
 * V2 orders; the operator took that out — a $10 minimum per order folded small ladders into one
 * leg — so the monitor runs every exit, and nothing guards a position while this process is down.
 *
 * `JUPITER_API_KEY` is optional: without it requests go out keyless (30/min, and `/execute` has
 * its own bucket). `SOLANA_RPC_URL` overrides the public RPC the three wallet reads use.
 */

const API = "https://api.jup.ag/swap/v2";
const WSOL = "So11111111111111111111111111111111111111112";
const RPC = "https://api.mainnet-beta.solana.com";

// ── base58 + key ──────────────────────────────────────────────────────

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function b58decode(s: string): Buffer {
  let n = 0n;
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) throw new Error("invalid base58");
    n = n * 58n + BigInt(i);
  }
  const hex = n.toString(16);
  const zeros = /^1*/.exec(s)![0].length;
  return Buffer.concat([Buffer.alloc(zeros), n === 0n ? Buffer.alloc(0) : Buffer.from(hex.length % 2 ? "0" + hex : hex, "hex")]);
}

export function b58encode(b: Uint8Array): string {
  let n = b.length ? BigInt("0x" + Buffer.from(b).toString("hex")) : 0n;
  let out = "";
  for (; n > 0n; n /= 58n) out = B58[Number(n % 58n)] + out;
  for (const x of b) {
    if (x !== 0) break;
    out = "1" + out;
  }
  return out;
}

/** DER header that turns a raw 32-byte ed25519 seed into the PKCS#8 `node:crypto` will load. */
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");

type Wallet = { key: KeyObject; pub: Buffer; address: string };

/** A Solana secret key as wallets export it: base58 or a JSON byte array, 64 bytes (seed + pubkey) or the bare 32-byte seed. */
export function parseKey(raw: string): Wallet {
  const bytes = raw.trim().startsWith("[") ? Buffer.from(JSON.parse(raw) as number[]) : b58decode(raw.trim());
  if (bytes.length !== 64 && bytes.length !== 32) throw new Error("SOLANA_PRIVATE_KEY must be a 32- or 64-byte key (base58 or JSON array)");
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, bytes.subarray(0, 32)]), format: "der", type: "pkcs8" });
  const pub = Buffer.from(createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32));
  return { key, pub, address: b58encode(pub) };
}

let cached: Wallet | null = null;

function wallet(): Wallet {
  const raw = process.env.SOLANA_PRIVATE_KEY?.trim();
  if (!raw) throw new Error("SOLANA_PRIVATE_KEY is not set");
  return (cached ??= parseKey(raw));
}

/** The address `SOLANA_PRIVATE_KEY` signs for, or null when it is unset or unreadable. */
export function address(): string | null {
  try {
    return wallet().address;
  } catch {
    return null;
  }
}

// ── signing ───────────────────────────────────────────────────────────

/** Solana's compact-u16: 7 bits per byte, low bits first. Returns [value, offset after it]. */
function shortU16(b: Buffer, at: number): [number, number] {
  let v = 0;
  for (let shift = 0; ; shift += 7) {
    const byte = b[at++]!;
    v |= (byte & 0x7f) << shift;
    if (!(byte & 0x80)) return [v, at];
  }
}

/**
 * Signs a serialized transaction in place and hands it back as base64.
 *
 * The wire format is `[signature count][64-byte slots][message]`; the message opens with an
 * optional version byte (high bit set on v0), three header bytes, then the account keys — and
 * the first `numRequiredSignatures` of those keys own the signature slots, in order. Only our
 * slot is written: an RFQ route carries a market maker's slot too, which `/execute` fills.
 */
export function signTransaction(txBase64: string, w: { key: KeyObject; pub: Buffer }): string {
  const tx = Buffer.from(txBase64, "base64");
  const [nSigs, sigsAt] = shortU16(tx, 0);
  const msg = tx.subarray(sigsAt + nSigs * 64);
  const header = msg[0]! & 0x80 ? 1 : 0;
  const required = msg[header]!;
  const [nKeys, keysAt] = shortU16(msg, header + 3);
  for (let i = 0; i < Math.min(required, nKeys, nSigs); i++) {
    if (!msg.subarray(keysAt + i * 32, keysAt + i * 32 + 32).equals(w.pub)) continue;
    sign(null, msg, w.key).copy(tx, sigsAt + i * 64);
    return tx.toString("base64");
  }
  throw new Error("transaction does not ask for this wallet's signature");
}

// ── swap ──────────────────────────────────────────────────────────────

async function http(url: string, o: { body?: string } = {}): Promise<Record<string, any>> {
  const key = process.env.JUPITER_API_KEY?.trim();
  const res = await fetch(url, {
    method: o.body ? "POST" : "GET",
    headers: {
      ...(o.body ? { "content-type": "application/json" } : {}),
      ...(key ? { "x-api-key": key } : {}),
    },
    ...(o.body ? { body: o.body } : {}),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`jupiter ${new URL(url).pathname} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as Record<string, any>;
}

/** Smallest-unit amounts as the wallet saw them: `inAmount` left it, `outAmount` arrived. */
export type SwapFill = { signature: string; inAmount: string; outAmount: string } | { error: string };

/**
 * Submits a real, irreversible on-chain swap from the `SOLANA_PRIVATE_KEY` wallet.
 *
 * `/execute` lands the transaction and waits for confirmation itself, so a `Success` here is a
 * settled trade — there is no order to poll. `slippagePct` 0 leaves the tolerance to Jupiter.
 */
export async function swap(a: { inputMint: string; outputMint: string; amount: string; slippagePct: number }): Promise<SwapFill> {
  let body: string;
  try {
    const w = wallet();
    const q = new URLSearchParams({ inputMint: a.inputMint, outputMint: a.outputMint, amount: a.amount, taker: w.address });
    if (a.slippagePct > 0) q.set("slippageBps", String(Math.round(a.slippagePct * 100)));
    const order = await http(`${API}/order?${q}`);
    // An empty transaction is a quote Jupiter could price but not build — no funds, no gas, no route.
    if (!order["transaction"])
      return { error: `jupiter built no transaction: ${order["errorMessage"] ?? order["error"] ?? "no reason given"}` };
    body = JSON.stringify({ signedTransaction: signTransaction(order["transaction"], w), requestId: order["requestId"] });
  } catch (e) {
    return { error: short(e) };
  }

  // Nothing has been sent until here, and from here a thrown fetch no longer means "not sent".
  // The signed transaction can only ever land once, so resubmitting the same body is safe.
  // ponytail: three tries, then the outcome is reported unknown — a landed buy would then sit
  // in the wallet unbooked. Read the signature's status off the RPC if that ever happens.
  for (let i = 0; ; i++) {
    try {
      const r = await http(`${API}/execute`, { body });
      if (r["status"] !== "Success") return { error: `jupiter swap failed (${r["code"]}): ${r["error"] ?? "unknown"}` };
      return {
        signature: String(r["signature"] ?? ""),
        inAmount: String(r["totalInputAmount"] ?? r["inputAmountResult"] ?? "0"),
        outAmount: String(r["totalOutputAmount"] ?? r["outputAmountResult"] ?? "0"),
      };
    } catch (e) {
      if (i >= 2) return { error: `jupiter execute outcome unknown — check the wallet: ${short(e)}` };
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// ── wallet reads (Solana RPC) ─────────────────────────────────────────

async function rpc(method: string, params: unknown[]): Promise<any> {
  const res = await fetch(process.env.SOLANA_RPC_URL?.trim() || RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  const j = (await res.json()) as Record<string, any>;
  if (j["error"]) throw new Error(`${method}: ${j["error"].message ?? res.status}`);
  return j["result"];
}

/** SOL in the wallet, or null when the RPC did not answer with a number. */
export async function solBalance(owner: string): Promise<number | null> {
  const v = (await rpc("getBalance", [owner, { commitment: "confirmed" }]))?.value;
  return typeof v === "number" ? v / 1e9 : null;
}

/** A mint's decimals, read off the chain — `/execute` reports amounts in smallest units only. */
export async function decimals(mint: string): Promise<number> {
  const d = (await rpc("getTokenSupply", [mint, { commitment: "confirmed" }]))?.value?.decimals;
  if (!Number.isInteger(d)) throw new Error(`no decimals for ${mint}`);
  return d;
}

/** What the wallet holds of one mint, in smallest units, summed over its token accounts. */
export async function tokenBalance(owner: string, mint: string): Promise<bigint> {
  const r = await rpc("getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed", commitment: "confirmed" }]);
  let sum = 0n;
  for (const a of r?.value ?? []) sum += BigInt(a?.account?.data?.parsed?.info?.tokenAmount?.amount ?? "0");
  return sum;
}
