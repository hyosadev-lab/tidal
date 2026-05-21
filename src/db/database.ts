import Database from 'better-sqlite3';
import { logger } from '../utils/logger.ts';
import { mkdirSync } from 'fs';

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  mkdirSync('data', { recursive: true });
  _db = new Database('data/trading-agent.db');
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  runMigrations(_db);
  logger.info('db_ready', { path: 'data/trading-agent.db' });

  return _db;
}

function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS token_candidates (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      mint_address         TEXT NOT NULL UNIQUE,
      symbol               TEXT,
      name                 TEXT,
      launchpad_platform   TEXT,
      graduated_at         INTEGER,
      first_seen_at        INTEGER DEFAULT (unixepoch()),
      liquidity_usd        REAL,
      holder_count         INTEGER,
      top_10_holder_rate   REAL,
      smart_degen_count    INTEGER,
      renowned_count       INTEGER,
      rug_ratio            REAL,
      creator_token_status TEXT,
      is_wash_trading      INTEGER,
      usd_market_cap       REAL,
      status               TEXT DEFAULT 'pending'
    );

    CREATE TABLE IF NOT EXISTS signal_scores (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      mint_address          TEXT NOT NULL,
      evaluated_at          INTEGER DEFAULT (unixepoch()),
      dip_score             REAL,
      momentum_score        REAL,
      smart_money_score     REAL,
      composite_score       REAL,
      dip_details           TEXT,
      momentum_details      TEXT,
      smart_money_details   TEXT,
      FOREIGN KEY (mint_address) REFERENCES token_candidates(mint_address)
    );

    CREATE TABLE IF NOT EXISTS ai_decisions (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      mint_address   TEXT NOT NULL,
      decision_type  TEXT NOT NULL,
      decided_at     INTEGER DEFAULT (unixepoch()),
      action         TEXT NOT NULL,
      confidence     REAL,
      reasoning      TEXT,
      red_flags      TEXT,
      raw_response   TEXT,
      FOREIGN KEY (mint_address) REFERENCES token_candidates(mint_address)
    );

    CREATE TABLE IF NOT EXISTS trades (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      mint_address         TEXT NOT NULL,
      side                 TEXT NOT NULL,
      executed_at          INTEGER DEFAULT (unixepoch()),
      sol_amount           REAL,
      token_amount         TEXT,
      price_usd            REAL,
      order_id             TEXT UNIQUE,
      strategy_order_id    TEXT,
      tx_hash              TEXT,
      status               TEXT DEFAULT 'pending',
      FOREIGN KEY (mint_address) REFERENCES token_candidates(mint_address)
    );

    CREATE TABLE IF NOT EXISTS positions (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      mint_address            TEXT NOT NULL UNIQUE,
      symbol                  TEXT,
      opened_at               INTEGER DEFAULT (unixepoch()),
      closed_at               INTEGER,
      entry_price_usd         REAL,
      exit_price_usd          REAL,
      sol_invested            REAL,
      token_amount            TEXT,
      sol_returned            REAL,
      pnl_usd                 REAL,
      pnl_pct                 REAL,
      exit_reason             TEXT,
      exit_handler            TEXT,
      strategy_order_id       TEXT,
      entry_holder_count      INTEGER,
      entry_smart_wallet_count INTEGER,
      status                  TEXT DEFAULT 'open',
      FOREIGN KEY (mint_address) REFERENCES token_candidates(mint_address)
    );

    CREATE TABLE IF NOT EXISTS daily_stats (
      date               TEXT PRIMARY KEY,
      trades_total       INTEGER DEFAULT 0,
      trades_won         INTEGER DEFAULT 0,
      trades_lost        INTEGER DEFAULT 0,
      pnl_usd            REAL DEFAULT 0,
      sol_traded         REAL DEFAULT 0,
      win_rate           REAL DEFAULT 0,
      avg_pnl_per_trade  REAL DEFAULT 0
    );
  `);
}
