import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";

test("schema: all tables, constraints enforced, reopening keeps data", () => {
  const dir = mkdtempSync(join(tmpdir(), "tta-db-"));
  const path = join(dir, "tta.db");
  try {
    let db = openDb(path);
    const tables = db.prepare("select name from sqlite_master where type = 'table' order by name").all();
    assert.deepEqual(
      tables.map((r) => r.name),
      ["agent_runs", "decisions", "equity", "exit_rules", "logs", "positions", "settings",
        "snapshot_flow", "token_signals", "token_snapshots", "tokens", "tool_calls", "trades"],
    );

    db.prepare("insert into tokens (address, first_seen_at) values ('Mint', 1)").run();
    db.prepare("insert into agent_runs (started_at, model, status) values (1, 'm', 'running')").run();
    const snap = "insert into token_snapshots (token, taken_at, kind, price_usd, raw) values (?, 1, 'decision', ?, '{}')";

    assert.throws(() => db.prepare(snap).run("Unknown", 1), /FOREIGN KEY/);
    assert.throws(() => db.prepare(snap).run("Mint", "abc"), /cannot store TEXT value in REAL column/);
    db.prepare(snap).run("Mint", "0.5"); // a numeric string still converts
    assert.throws(
      () => db.prepare("insert into decisions (run_id, token, action) values (1, 'Mint', 'sell')").run(),
      /CHECK/,
    );
    db.close();

    db = openDb(path);
    assert.equal(db.prepare("select price_usd from token_snapshots").get()?.price_usd, 0.5);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
