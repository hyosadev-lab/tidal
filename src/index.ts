import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { store } from "./angel/state/store.ts";
import * as engine from "./angel/engine.ts";

const PUBLIC = join(fileURLToPath(new URL("..", import.meta.url)), "public");
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
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > 256 * 1024) throw new Error("body too large");
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
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
    const cfg = store.updateConfig(body ?? {});
    if (cfg.intervalMinutes !== before.intervalMinutes || cfg.monitorSeconds !== before.monitorSeconds)
      engine.reschedule();
    if (cfg.mode !== before.mode) store.log("info", `Mode switched to ${cfg.mode}.`);
    if (cfg.chain !== before.chain) store.log("info", `Chain switched to ${cfg.chain.toUpperCase()}.`);
    // Live sizing is the wallet's, not the paper bankroll's. Without this the dashboard
    // shows the paper number until the next scan — and that number is what the operator
    // reads before deciding whether to start the agent at all.
    if (cfg.mode === "live" && (cfg.mode !== before.mode || cfg.chain !== before.chain))
      await engine.syncLiveBalance();
    // Paper equity and wallet equity are different pots of money, so the yardsticks that
    // compare them — day PnL, drawdown, the loss halt — start again on a mode switch.
    if (cfg.mode !== before.mode) store.rebase();
    store.push();
    return { ok: true, config: cfg };
  },

  "/api/start": async (body) => {
    if (body?.config) store.updateConfig(body.config);
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
  try {
    if (path === "/api/stream") return stream(req, res);

    const action = req.method === "POST" ? ACTIONS[path] : undefined;
    if (action) {
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
