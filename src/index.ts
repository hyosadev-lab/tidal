import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { store } from "./core/data/store.ts";
import * as engine from "./core/runtime.ts";
import { chainLock } from "./core/domain/config.ts";
import { GAS_RESERVE } from "./core/domain/chains.ts";
import { authProblem, hasSession, loginPage, sameOriginPost, sameSecret, sessionCookie } from "./auth.ts";

const PUBLIC = join(fileURLToPath(new URL("..", import.meta.url)), "public");
const PORT = Number(process.env.PORT ?? 3111);
const HOST = process.env.HOST ?? "127.0.0.1";
const TOKEN = process.env.DASHBOARD_TOKEN || undefined;

const problem = authProblem(HOST, TOKEN);
if (problem) {
  console.error(`  ! ${problem}`);
  process.exit(1);
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

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

async function readBody(req: IncomingMessage): Promise<any> {
  const text = await readText(req);
  return text ? JSON.parse(text) : {};
}

const HTML = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };

/** The one route open without a session: trade the token for a cookie. */
async function login(req: IncomingMessage, res: ServerResponse, token: string): Promise<void> {
  const given = new URLSearchParams(await readText(req)).get("token") ?? "";
  if (!sameSecret(given, token)) {
    await new Promise((r) => setTimeout(r, 1000)); // slows guessing; a per-IP lockout behind a proxy would lock out everyone
    res.writeHead(401, HTML).end(loginPage("Token salah."));
    return;
  }
  // Behind Caddy/nginx the socket is plain HTTP; the proxy says whether the browser's side was TLS.
  const secure = req.headers["x-forwarded-proto"] === "https";
  res.writeHead(303, { location: "/", "set-cookie": sessionCookie(token, secure) }).end();
}

async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
  const file = join(PUBLIC, urlPath === "/" ? "index.html" : urlPath);
  if (!file.startsWith(PUBLIC + sep)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const buf = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(buf);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  }
}

function stream(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  const send = (ev: string, data: unknown) => void res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
  send("snapshot", store.snapshot());
  const unsub = store.subscribe(send);
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  req.on("close", () => {
    clearInterval(ping);
    unsub();
  });
}

/** Every action answers `{ ok }`; false becomes a 400. */
const ACTIONS: Record<string, (body: any) => Promise<{ ok: boolean; [k: string]: unknown }>> = {
  "/api/config": async (body) => {
    const before = store.config;
    const locked = chainLock(before, store.positions.length, body ?? {});
    if (locked) return { ok: false, error: locked };
    const cfg = store.updateConfig(body ?? {});
    if (cfg.mode !== before.mode) store.log("info", `Mode switched to ${cfg.mode}.`);
    if (cfg.chain !== before.chain) store.log("info", `Chain switched to ${cfg.chain.toUpperCase()}.`);
    // Live sizing is the wallet's, not the paper bankroll's. Without this the dashboard
    // shows the paper number until the next scan — and that number is what the operator
    // reads before deciding whether to start the agent at all.
    if (cfg.mode === "live" && (cfg.mode !== before.mode || cfg.chain !== before.chain || cfg.walletAddress !== before.walletAddress))
      await engine.syncLiveBalance();
    // Paper equity and wallet equity are different pots of money, so the yardsticks that
    // compare them — day PnL, drawdown, the loss halt — start again on a mode switch.
    if (cfg.mode !== before.mode) store.rebase();
    store.push();
    return { ok: true, config: cfg };
  },

  "/api/start": async (body) => {
    if (body?.config) {
      const locked = chainLock(store.config, store.positions.length, body.config);
      if (locked) return { ok: false, error: locked };
      store.updateConfig(body.config);
    }
    return engine.start();
  },

  "/api/stop": async () => {
    engine.stop();
    return { ok: true };
  },

  "/api/scan": async () => {
    void engine.scanNow();
    return { ok: true };
  },

  "/api/close": async (body) => engine.manualClose(String(body?.id ?? ""), Number(body?.percent ?? 100)),

  "/api/reset": async () => {
    engine.stop();
    store.reset();
    // A cleared ledger re-seeds from the paper bankroll. In live that is the wrong pot:
    // without this the fresh baseline sits at $1000 against a wallet worth a fraction of
    // it, and the first cycle halts on the daily loss cap.
    if (store.config.mode === "live") await engine.syncLiveBalance();
    store.rebase();
    store.push();
    return { ok: true };
  },
};

const server = createServer(async (req, res) => {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("x-content-type-options", "nosniff");
  try {
    if (TOKEN) {
      if (path === "/login" && req.method === "POST") return await login(req, res, TOKEN);
      if (!hasSession(req.headers.cookie, TOKEN)) {
        if (path.startsWith("/api/")) return json(res, 401, { error: "login required — reload the page" });
        res.writeHead(401, HTML).end(loginPage());
        return;
      }
    }

    if (path === "/api/stream") return stream(req, res);
    if (path === "/api/wallets") {
      const fresh = new URL(req.url ?? "/", "http://localhost").searchParams.has("fresh");
      const body = await engine.wallets(fresh).then(
        (w) => ({ wallets: w.list, at: w.at, gasReserve: GAS_RESERVE }),
        (e) => ({ wallets: [], error: String(e?.message ?? e), gasReserve: GAS_RESERVE }),
      );
      return json(res, 200, body);
    }

    const action = req.method === "POST" ? ACTIONS[path] : undefined;
    if (action) {
      if (!sameOriginPost(req.headers["content-type"])) return json(res, 415, { error: "application/json required" });
      const r = await action(await readBody(req));
      return json(res, r.ok ? 200 : 400, r);
    }

    if (path.startsWith("/api/")) return json(res, 404, { error: "unknown endpoint" });
    await serveStatic(res, path);
  } catch (e) {
    json(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  tidal · dashboard on http://${HOST}:${PORT}`);
  console.log(`  mode: ${store.config.mode}   chain: ${store.config.chain}`);
  if (!process.env.OPENROUTER_API_KEY) console.log("  ! OPENROUTER_API_KEY missing — set it in .env before starting the agent");
  if (process.env.GMGN_ALLOW_AUTOMATED_TRADES === "1") console.log("  ! automated live trades are ENABLED in this shell");
  console.log("");
});

for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    engine.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  });
