/**
 * The ledger: one SQLite file, `data/tta.db` via `node:sqlite` (`TTA_DB` overrides it).
 * `schema.dbml` at the repo root is the documented design — keep the two in step.
 *
 * Tables are STRICT: GMGN sends numbers as strings, and a string that is not a number must
 * fail at write instead of landing in a REAL column as text.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PATH = fileURLToPath(new URL("../data/tta.db", import.meta.url));

// ponytail: `if not exists` never alters a table that is already there. The first schema change
// after real data lands needs a `pragma user_version` step in openDb.
const SCHEMA = `
create table if not exists settings (
  key text primary key,
  value text not null,
  updated_at integer not null
) strict;

create table if not exists tokens (
  address text primary key,
  symbol text,
  name text,
  decimals integer,
  standard text,
  creator_address text,
  launchpad text,
  launchpad_platform text,
  created_at integer,
  opened_at integer,
  migrated_at integer,
  first_seen_at integer not null,
  blocked_at integer,
  blocked_reason text
) strict;
create index if not exists tokens_creator on tokens(creator_address);

create table if not exists agent_runs (
  id integer primary key,
  started_at integer not null,
  finished_at integer,
  model text not null,
  status text not null check (status in ('running', 'ok', 'error')),
  error text,
  input_tokens integer,
  output_tokens integer,
  messages text
) strict;

create table if not exists tool_calls (
  id integer primary key,
  run_id integer not null references agent_runs(id),
  at integer not null,
  name text not null,
  args text,
  result text
) strict;
create index if not exists tool_calls_run on tool_calls(run_id);

create table if not exists decisions (
  id integer primary key,
  run_id integer not null references agent_runs(id),
  token text not null references tokens(address),
  action text not null check (action in ('buy', 'wait', 'skip')),
  conviction integer check (conviction between 0 and 100),
  thesis text,
  recheck_at integer
) strict;
create index if not exists decisions_token on decisions(token, id);
create index if not exists decisions_recheck on decisions(recheck_at);

create table if not exists token_snapshots (
  id integer primary key,
  token text not null references tokens(address),
  taken_at integer not null,
  kind text not null check (kind in ('entry', 'exit', 'decision')),
  decision_id integer references decisions(id),

  price_usd real not null,
  market_cap_usd real,
  ath_price_usd real,
  liquidity_usd real,
  holder_count integer,
  circulating_supply real,
  total_supply real,
  locked_ratio real,
  launchpad_progress real,
  migration_market_cap real,
  trade_fee real,
  total_fee real,
  hot_level integer,
  visiting_count integer,
  image_dup_count integer,

  pool_address text,
  pool_exchange text,
  pool_quote_symbol text,
  pool_base_reserve real,
  pool_quote_reserve real,
  pool_initial_liquidity real,
  pool_initial_base_reserve real,
  pool_initial_quote_reserve real,

  top_10_holder_rate real,
  dev_team_hold_rate real,
  creator_hold_rate real,
  top_bundler_trader_percentage real,
  top70_sniper_hold_rate real,
  fresh_wallet_rate real,
  bot_degen_rate real,
  bot_degen_count integer,
  top_rat_trader_percentage real,
  top_entrapment_trader_percentage real,
  private_vault_hold_rate real,
  signal_count integer,
  degen_call_count integer,

  smart_wallets integer,
  renowned_wallets integer,
  whale_wallets integer,
  top_wallets integer,
  fresh_wallets integer,
  sniper_wallets integer,
  bundler_wallets integer,
  rat_trader_wallets integer,
  creator_wallets integer,

  creator_token_status text,
  creator_token_balance real,
  creator_open_count integer,
  creator_created_count integer,
  dev_ath_token text,
  dev_ath_mc_usd real,
  cto_flag integer,
  twitter_create_token_count integer,
  twitter_del_post_token_count integer,
  twitter_name_changes integer,

  dexscr_ad integer,
  dexscr_update_link integer,
  dexscr_boost_fee real,
  dexscr_trending_bar integer,

  twitter text,
  website text,
  telegram text,

  raw text not null
) strict;
create index if not exists snapshots_token on token_snapshots(token, taken_at);
create index if not exists snapshots_kind on token_snapshots(kind);

create table if not exists snapshot_flow (
  snapshot_id integer not null references token_snapshots(id),
  span text not null check (span in ('1m', '5m', '1h', '6h', '24h')),
  price_usd real,
  buys integer,
  sells integer,
  swaps integer,
  volume_usd real,
  buy_volume_usd real,
  sell_volume_usd real,
  primary key (snapshot_id, span)
) strict;

create table if not exists token_signals (
  id text primary key,
  token text not null,
  signal_type integer not null,
  trigger_at integer not null,
  trigger_mc real,
  first_trigger_mc real,
  signal_times integer,
  times_by_type text
) strict;
create index if not exists token_signals_token on token_signals(token, trigger_at);

create table if not exists positions (
  id integer primary key,
  token text not null references tokens(address),
  decision_id integer references decisions(id),
  entry_snapshot_id integer not null unique references token_snapshots(id),
  exit_snapshot_id integer unique references token_snapshots(id),
  mode text not null check (mode in ('paper', 'live')),
  wallet text,
  status text not null check (status in ('open', 'closed')),
  opened_at integer not null,
  closed_at integer,
  close_reason text,
  entry_price_usd real not null,
  cost_usd real not null,
  original_qty text not null,
  qty text not null,
  breakeven_pct real,
  entry_liquidity_usd real,
  entry_market_cap_usd real,
  last_price_usd real,
  peak_price_usd real
) strict;
create index if not exists positions_status on positions(status);
create index if not exists positions_cooldown on positions(token, closed_at);

create table if not exists exit_rules (
  id integer primary key,
  position_id integer not null references positions(id),
  seq integer not null,
  kind text not null check (kind in ('tp', 'sl')),
  at_pct real not null,
  sell_pct real not null,
  filled_at integer,
  unique (position_id, seq)
) strict;

create table if not exists trades (
  id integer primary key,
  position_id integer not null references positions(id),
  exit_rule_id integer references exit_rules(id),
  at integer not null,
  side text not null check (side in ('buy', 'sell')),
  qty text not null,
  price_usd real not null,
  usd real not null,
  pnl_usd real,
  reason text not null,
  tx_signature text unique
) strict;
create index if not exists trades_at on trades(at);
create index if not exists trades_position on trades(position_id);

create table if not exists equity (
  at integer primary key,
  equity_usd real not null,
  cash_usd real not null
) strict;

create table if not exists logs (
  id integer primary key,
  at integer not null,
  level text not null,
  msg text not null,
  detail text
) strict;
`;

/** The process's ledger, set by the last `openDb`. One per process: tests reopen it on ":memory:". */
export let db!: DatabaseSync;

/** Opens (creating if needed) the ledger, applies the schema and makes it `db`. */
export function openDb(path = process.env.TTA_DB || DEFAULT_PATH): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  db = new DatabaseSync(path);
  db.exec("pragma journal_mode = wal; pragma synchronous = normal; pragma foreign_keys = on;");
  db.exec(SCHEMA);
  return db;
}

/**
 * Inserts one row from an object whose keys are column names, and returns its id. `table` and
 * the keys come from code, never from data; undefined values are stored as null.
 */
export function insert(table: string, row: Record<string, unknown>): number {
  const keys = Object.keys(row);
  const values = Object.fromEntries(keys.map((k) => [k, (row[k] ?? null) as never]));
  const sql = `insert into ${table} (${keys.join(", ")}) values (${keys.map((k) => `$${k}`).join(", ")})`;
  return Number(db.prepare(sql).run(values).lastInsertRowid);
}

/** Runs `fn` in one transaction: all of it lands, or none of it. */
export function tx<T>(fn: () => T): T {
  db.exec("begin");
  try {
    const out = fn();
    db.exec("commit");
    return out;
  } catch (e) {
    db.exec("rollback");
    throw e;
  }
}
