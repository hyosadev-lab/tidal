import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { hasSession, loginPage, sameOriginPost, sameSecret, sessionCookie } from "./auth.ts";
import { cleanPlan, loadConfig, sanitize, saveConfig } from "./config.ts";
import * as control from "./control.ts";
import { entryLoop, wake } from "./entry.ts";
import * as jup from "./jupiter/client.ts";
import { log } from "./log.ts";
import { lastSolUsd, sampleEquity } from "./trade.ts";
import * as view from "./view.ts";

/**
 * The dashboard: static files from `public/` and a small JSON API over the ledger. Reads poll
 * `/api/state`; every write is a POST with an application/json body (see `sameOriginPost`).
 */

const PUBLIC = fileURLToPath(new URL("../public/", import.meta.url));
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};
const HTML = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readText(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > 256 * 1024) throw new Error("body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function serveStatic(res: ServerResponse, path: string): Promise<void> {
  const file = join(PUBLIC, path === "/" ? "index.html" : path);
  if (!file.startsWith(PUBLIC) || file.includes(`${sep}..`)) return void res.writeHead(403).end("forbidden");
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" }).end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  }
}

/** Every action answers `{ ok }`; false becomes a 400. */
const ACTIONS: Record<string, (body: any) => Promise<{ ok: boolean; [k: string]: unknown }>> = {
  "/api/start": async () => (control.start(), void entryLoop(), { ok: true }),
  "/api/stop": async (b) => ({ ok: true, errors: await control.stop(b?.closeAll === true) }),
  "/api/resume": async () => (control.resume(), wake(), { ok: true }),
  "/api/close": async (b) => {
    const err = await control.closePosition(Number(b?.id));
    return err ? { ok: false, error: err } : { ok: true };
  },
  "/api/settings": async (b) => {
    const input = b?.config ?? {};
    if (input.plan !== undefined && !cleanPlan(input.plan))
      return { ok: false, error: "The fixed plan must sell 100% on take profit and 100% on stop loss." };
    const before = loadConfig();
    const cfg = sanitize({ ...before, ...input });
    if (cfg.mode === "live" && !jup.address()) return { ok: false, error: "Live stays off while SOLANA_PRIVATE_KEY is unset." };
    saveConfig(cfg);
    // The new mode's curve starts now, not at the next minute's sample; a failure waits for that one.
    if (cfg.mode !== before.mode) void sampleEquity(cfg).catch(() => {});
    wake(); // more slots, a looser loss limit or a new mode may let an idle loop buy
    log("info", `Settings saved${cfg.mode !== before.mode ? ` — mode is now ${cfg.mode}` : ""}.`);
    return { ok: true, config: cfg };
  },
};

function state(url: URL) {
  const cfg = loadConfig();
  const now = Date.now();
  const tz = view.zone(url.searchParams.get("tz"));
  return {
    now,
    config: cfg,
    liveAvailable: !!jup.address(),
    solUsd: lastSolUsd(),
    health: view.health(cfg, now, tz),
    overview: view.overview(cfg, url.searchParams.get("range") ?? "7d", now, tz),
    trading: view.trading(cfg, now, tz),
  };
}

export function startServer(o: { port: number; host: string; token?: string }): Server {
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(o.host);
  // Without a token the only lock is the address. A page elsewhere that rebinds its own name to
  // 127.0.0.1 would be same-origin to this server, so the Host header has to be ours.
  const hosts = new Set([`${o.host}:${o.port}`, `127.0.0.1:${o.port}`, `localhost:${o.port}`, `[::1]:${o.port}`]);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    try {
      if (o.token) {
        if (path === "/login" && req.method === "POST") {
          const given = new URLSearchParams(await readText(req)).get("token") ?? "";
          if (!sameSecret(given, o.token)) {
            await new Promise((r) => setTimeout(r, 1000)); // slows guessing
            return void res.writeHead(401, HTML).end(loginPage(true));
          }
          const secure = req.headers["x-forwarded-proto"] === "https";
          return void res.writeHead(303, { location: "/", "set-cookie": sessionCookie(o.token, secure) }).end();
        }
        if (!hasSession(req.headers.cookie, o.token)) {
          if (path.startsWith("/api/")) return json(res, 401, { error: "Signed out — reload the page." });
          return void res.writeHead(401, HTML).end(loginPage(false));
        }
      } else if (!loopback || !hosts.has(String(req.headers.host))) return void res.writeHead(403).end("forbidden");

      if (req.method === "GET" && path === "/api/state") return json(res, 200, state(url));
      if (req.method === "GET" && path === "/api/run") {
        const r = view.runDetail(Number(url.searchParams.get("id")));
        return r ? json(res, 200, r) : json(res, 404, { error: "no such run" });
      }
      if (req.method === "GET" && path === "/api/activity") {
        const before = Number(url.searchParams.get("before"));
        const since = Number(url.searchParams.get("since"));
        if (!Number.isSafeInteger(before) || !Number.isSafeInteger(since)) return json(res, 400, { error: "before and since must be integers" });
        return json(res, 200, view.activityBefore(before, since));
      }
      if (req.method === "GET" && path === "/api/runs") {
        const before = Number(url.searchParams.get("before"));
        const since = Number(url.searchParams.get("since"));
        if (!Number.isSafeInteger(before) || !Number.isSafeInteger(since)) return json(res, 400, { error: "before and since must be integers" });
        return json(res, 200, view.runsBefore(before, since, url.searchParams.get("failed") === "1"));
      }
      if (req.method === "GET" && path === "/api/token")
        return json(res, 200, view.tokenDetail(String(url.searchParams.get("address") ?? ""), loadConfig(), Date.now()));

      const action = req.method === "POST" ? ACTIONS[path] : undefined;
      if (action) {
        if (!sameOriginPost(req.headers["content-type"])) return json(res, 415, { error: "application/json required" });
        const text = await readText(req);
        const r = await action(text ? JSON.parse(text) : {});
        return json(res, r.ok ? 200 : 400, r);
      }
      if (path.startsWith("/api/")) return json(res, 404, { error: "unknown endpoint" });
      if (req.method !== "GET") return void res.writeHead(405).end();
      await serveStatic(res, path);
    } catch (e) {
      json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  });
  server.listen(o.port, o.host, () => log("info", `Dashboard on http://${o.host}:${o.port}${o.token ? " (sign-in required)" : ""}`));
  return server;
}
