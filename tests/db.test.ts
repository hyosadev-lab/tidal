import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/db.ts";

test("schema: all tables, constraints enforced, reopening keeps data", () => {
  const dir = mkdtempSync(join(tmpdir(), "tta-db-"));
  const path = join(dir, "tta.db");
  try {
    let db = openDb(path);
    const tables = db.prepare("select name from sqlite_master where type = 'table' order by name").all();
    assert.deepEqual(
      tables.map((r) => r.name),
      ["agent_runs", "config_history", "decisions", "equity", "exit_rules", "hypotheses", "logs",
        "positions", "settings", "shadow_tracks", "snapshot_flow", "token_signals", "token_snapshots",
        "tokens", "tool_calls", "trades"],
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

    // A decision track needs its decision; a track from another feed must not have one.
    const track = "insert into shadow_tracks (token, source, decision_id, features, started_at) values ('Mint', ?, ?, '{}', 1)";
    assert.throws(() => db.prepare(track).run("decision", null), /CHECK/);
    assert.throws(() => db.prepare(track).run("rank", 1), /CHECK/);
    db.prepare(track).run("rank", null);

    // A track ends with its reason, and only a known one.
    const end = db.prepare("update shadow_tracks set ended_at = ?, end_reason = ?");
    assert.throws(() => end.run(2, null), /CHECK/);
    assert.throws(() => end.run(null, "done"), /CHECK/);
    assert.throws(() => end.run(2, "sold"), /CHECK/);
    end.run(2, "rug");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("schema: a ledger from before the new columns gains them, old rows keep their values", () => {
  const dir = mkdtempSync(join(tmpdir(), "tta-db-"));
  const path = join(dir, "tta.db");
  try {
    const old = new DatabaseSync(path);
    old.exec(`
      create table agent_runs (id integer primary key, started_at integer not null, finished_at integer,
        model text not null, status text not null, error text, input_tokens integer, output_tokens integer,
        messages text) strict;
      create table trades (id integer primary key, position_id integer not null, exit_rule_id integer,
        at integer not null, side text not null, qty text not null, price_usd real not null, usd real not null,
        pnl_usd real, reason text not null, tx_signature text unique) strict;
      create table equity (at integer primary key, equity_usd real not null, cash_usd real not null) strict;
      create table shadow_tracks (id integer primary key, token text not null, source text not null,
        decision_id integer unique, features text not null, started_at integer not null, ended_at integer) strict;
      insert into agent_runs (started_at, model, status) values (1, 'm', 'ok');
      insert into equity values (1, 1000, 1000);`);
    old.close();

    for (let i = 0; i < 2; i++) {
      const db = openDb(path); // the second open finds every column and changes nothing
      assert.equal(db.prepare("select kind from agent_runs").get()?.kind, "entry");
      assert.equal(db.prepare("select mode from equity").get()?.mode, "paper");
      assert.ok(db.prepare("select 1 from pragma_table_info('trades') where name = 'quote_price_usd'").get());
      // The added column brings its checks: an end needs a reason.
      assert.throws(() => db.prepare("insert into shadow_tracks (token, source, features, started_at, ended_at) values ('M', 'rank', '{}', 1, 2)").run(), /CHECK/);
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
