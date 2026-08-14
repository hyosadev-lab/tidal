/**
 * One SQLite file behind everything persisted — `data/tta.db`, via `node:sqlite`.
 * Stdlib, so still zero runtime dependencies.
 *
 * Split by shape, not by taste:
 *   - bounded, mutated-in-place state (config, cash, open positions, cooldowns) is a JSON
 *     blob in `kv`. The engine mutates those objects directly all over `engine.ts`;
 *     rewriting a few kB per debounced save is cheaper than mapping them to columns.
 *   - unbounded append-only series (trades, equity, soundings, outcomes) are rows. They are
 *     no longer capped by what fits in one file rewrite, and `calibrate.ts` can read them
 *     from a second process while the engine trades — WAL, one writer, many readers.
 *
 * `TTA_DB` overrides the path (tests point it at a scratch file).
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Repo root — `data/` stays beside the sources, not inside `src/`. Counted from this file's
 * own location (`src/trading/state/`), so moving this file moves the database with it.
 */
export const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
export const DATA_DIR = join(ROOT, "data");
const DB_PATH = process.env.TTA_DB || join(DATA_DIR, "tta.db");

mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec(`
  pragma journal_mode = wal;
  pragma synchronous = normal;
  create table if not exists kv (k text primary key, v text not null);
  create table if not exists trades (
    id text primary key, at integer not null, side text not null, pnl real, json text not null);
  create index if not exists trades_at on trades(at desc);
  create table if not exists equity (at integer primary key, equity real not null);
  create table if not exists soundings (
    key text primary key, ts integer not null, cycle integer not null, chain text not null, json text not null);
  create index if not exists soundings_ts on soundings(ts);
  create table if not exists outcomes (key text primary key, json text not null);
`);

export function kvGet<T>(k: string): T | undefined {
  const row = db.prepare("select v from kv where k = ?").get(k) as { v: string } | undefined;
  if (!row) return undefined;
  try {
    return JSON.parse(row.v) as T;
  } catch {
    return undefined;
  }
}

export function kvSet(k: string, v: unknown): void {
  db.prepare("insert into kv (k, v) values (?, ?) on conflict(k) do update set v = excluded.v").run(k, JSON.stringify(v));
}

/**
 * One-shot import of the pre-SQLite files, then they are renamed out of the way so a second
 * run cannot double-count. Only runs on an empty database — `data/` is gitignored working
 * state, so this is a courtesy to whoever was mid-run, not a migration framework to maintain.
 */
function importLegacyFiles(): void {
  // Only the real database adopts `data/`; a scratch db (tests) must not move the operator's files.
  if (process.env.TTA_DB) return;
  if ((db.prepare("select count(*) n from kv").get() as { n: number }).n > 0) return;
  const take = (name: string): unknown[] | Record<string, unknown> | null => {
    const path = join(DATA_DIR, name);
    if (!existsSync(path)) return null;
    try {
      const text = readFileSync(path, "utf8");
      const rows = name.endsWith(".jsonl")
        ? text
            .split("\n")
            .filter((l) => l.trim())
            .flatMap((l) => {
              try {
                return [JSON.parse(l) as unknown];
              } catch {
                return []; // half-written last line
              }
            })
        : (JSON.parse(text) as Record<string, unknown>);
      renameSync(path, `${path}.migrated`);
      return rows;
    } catch {
      return null;
    }
  };

  const cfg = take("config.json");
  if (cfg) kvSet("config", cfg);

  const state = take("state.json") as Record<string, unknown> | null;
  if (state) {
    const trades = Array.isArray(state.trades) ? (state.trades as Record<string, unknown>[]) : [];
    const equity = Array.isArray(state.equity) ? (state.equity as { at: number; equity: number }[]) : [];
    delete state.trades;
    delete state.equity;
    kvSet("state", state);
    for (const t of trades) insertTrade(t as never);
    for (const p of equity) insertEquity(p.at, p.equity);
  }

  for (const s of (take("soundings.jsonl") as { ts: number; cycle: number; chain: string }[]) ?? [])
    insertSounding(`${s.cycle}:${(s as { c?: { address?: string } }).c?.address}`, s);
  for (const o of (take("outcomes.jsonl") as { key: string }[]) ?? []) insertOutcome(o.key, o);
}

// ── row writers shared by store.ts / soundings.ts (and the import above) ──

export function insertTrade(t: { id: string; at: number; side: string; pnlUsd?: number }): void {
  db.prepare("insert or replace into trades (id, at, side, pnl, json) values (?, ?, ?, ?, ?)").run(
    t.id,
    t.at,
    t.side,
    t.pnlUsd ?? null,
    JSON.stringify(t),
  );
}

export function insertEquity(at: number, equity: number): void {
  db.prepare("insert or replace into equity (at, equity) values (?, ?)").run(at, equity);
}

export function insertSounding(key: string, s: { ts: number; cycle: number; chain: string }): void {
  db.prepare("insert or ignore into soundings (key, ts, cycle, chain, json) values (?, ?, ?, ?, ?)").run(
    key,
    s.ts,
    s.cycle,
    s.chain,
    JSON.stringify(s),
  );
}

export function insertOutcome(key: string, o: unknown): void {
  db.prepare("insert or replace into outcomes (key, json) values (?, ?)").run(key, JSON.stringify(o));
}

/** `select json from …` rows back into objects. */
export const rowsJson = <T>(sql: string, ...params: (string | number)[]): T[] =>
  (db.prepare(sql).all(...params) as { json: string }[]).map((r) => JSON.parse(r.json) as T);

importLegacyFiles();
