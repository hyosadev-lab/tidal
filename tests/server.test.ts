import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { createServer, type Server } from "node:net";
import { openDb } from "../src/db.ts";
import { startServer } from "../src/server.ts";

const TOKEN = "t".repeat(40); // a test token, never a real one

const freePort = () =>
  new Promise<number>((resolve) => {
    const s: Server = createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

async function serve(token?: string) {
  openDb(":memory:");
  const port = await freePort();
  const server = startServer({ port, host: "127.0.0.1", token });
  await new Promise((r) => server.once("listening", r));
  return { base: `http://127.0.0.1:${port}`, port, close: () => new Promise((r) => server.close(r)) };
}

test("with a token: everything is behind the sign-in, and writes need a JSON body", async () => {
  const s = await serve(TOKEN);
  try {
    assert.equal((await fetch(`${s.base}/api/state`)).status, 401);
    const page = await fetch(`${s.base}/`);
    assert.equal(page.status, 401);
    assert.match(await page.text(), /Dashboard token/);

    const wrong = await fetch(`${s.base}/login`, { method: "POST", body: new URLSearchParams({ token: "nope" }), redirect: "manual" });
    assert.equal(wrong.status, 401);
    assert.match(await wrong.text(), /does not match/);

    const right = await fetch(`${s.base}/login`, { method: "POST", body: new URLSearchParams({ token: TOKEN }), redirect: "manual" });
    assert.equal(right.status, 303);
    const cookie = right.headers.get("set-cookie")!.split(";")[0]!;
    assert.ok(!cookie.includes(TOKEN));

    const state = await fetch(`${s.base}/api/state`, { headers: { cookie } });
    assert.equal(state.status, 200);
    assert.equal((await state.json()).config.mode, "paper");
    const form = await fetch(`${s.base}/api/start`, { method: "POST", headers: { cookie, "content-type": "text/plain" }, body: "{}" });
    assert.equal(form.status, 415);
    const bad = await fetch(`${s.base}/api/settings`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ config: { plan: [{ kind: "tp", at: 50, sell: 90 }, { kind: "sl", at: -20, sell: 100 }] } }),
    });
    assert.equal(bad.status, 400);
  } finally {
    await s.close();
  }
});

test("without a token: only requests addressed to this host get in (no DNS rebinding)", async () => {
  const s = await serve(undefined);
  try {
    assert.equal((await fetch(`${s.base}/api/state`)).status, 200);
    // fetch drops a hand-set Host header, so this one goes out over node:http.
    const status = (host: string) =>
      new Promise<number>((resolve, reject) =>
        request({ port: s.port, host: "127.0.0.1", path: "/api/state", headers: { host } }, (res) => (res.resume(), resolve(res.statusCode!)))
          .on("error", reject)
          .end(),
      );
    assert.equal(await status(`evil.example:${s.port}`), 403);
    assert.equal(await status(`localhost:${s.port}`), 200);
  } finally {
    await s.close();
  }
});
