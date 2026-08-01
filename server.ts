import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { store } from "./trading/store.ts";
import * as engine from "./trading/engine.ts";
import { configOk } from "./trading/gmgn.ts";
import { liveReady } from "./trading/config.ts";

const PUBLIC = join(fileURLToPath(new URL(".", import.meta.url)), "public");
const PORT = Number(process.env.PORT ?? 3111);
const HOST = process.env.HOST ?? "127.0.0.1";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function json(res: ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(s);
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 256 * 1024) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
  const rel = normalize(urlPath === "/" ? "/index.html" : urlPath).replace(/^(\.\.[/\\])+/, "");
  const file = join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) {
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

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;

  try {
    // ── live updates ────────────────────────────────────────────────
    if (path === "/api/stream") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      const send = (ev: string, data: unknown) => {
        res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      send("snapshot", store.snapshot());
      const unsub = store.subscribe(send);
      const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
      req.on("close", () => {
        clearInterval(ping);
        unsub();
      });
      return;
    }

    if (path === "/api/state") return json(res, 200, store.snapshot());

    if (path === "/api/health") {
      const cli = await configOk();
      const live = liveReady(store.config);
      return json(res, 200, {
        gmgnCli: cli,
        openrouter: Boolean(process.env.OPENROUTER_API_KEY),
        liveReady: live.ok,
        liveReason: live.reason,
        automatedTradesEnv: process.env.GMGN_ALLOW_AUTOMATED_TRADES === "1",
      });
    }

    if (req.method === "POST") {
      const body = await readBody(req);

      if (path === "/api/config") {
        const before = store.config;
        const cfg = store.updateConfig(body ?? {});
        if (cfg.intervalMinutes !== before.intervalMinutes || cfg.monitorSeconds !== before.monitorSeconds)
          engine.reschedule();
        if (cfg.mode !== before.mode) store.log("info", `Mode switched to ${cfg.mode}.`);
        if (cfg.chain !== before.chain) store.log("info", `Chain switched to ${cfg.chain.toUpperCase()}.`);
        store.push();
        return json(res, 200, { ok: true, config: cfg });
      }

      if (path === "/api/start") {
        if (body?.config) store.updateConfig(body.config);
        const r = await engine.start();
        return json(res, r.ok ? 200 : 400, r);
      }

      if (path === "/api/stop") {
        engine.stop();
        return json(res, 200, { ok: true });
      }

      if (path === "/api/scan") {
        void engine.scanNow();
        return json(res, 200, { ok: true });
      }

      if (path === "/api/close") {
        const r = await engine.manualClose(String(body?.id ?? ""), Number(body?.percent ?? 100));
        return json(res, r.ok ? 200 : 400, r);
      }

      if (path === "/api/reset") {
        engine.stop();
        store.reset();
        return json(res, 200, { ok: true });
      }

      return json(res, 404, { error: "unknown endpoint" });
    }

    if (path.startsWith("/api/")) return json(res, 404, { error: "unknown endpoint" });
    await serveStatic(res, path);
  } catch (e) {
    json(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  tidal · dashboard on http://${HOST}:${PORT}`);
  console.log(`  mode: ${store.config.mode}   chain: ${store.config.chain}   interval: ${store.config.intervalMinutes}m`);
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
