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
    CREATE TABLE IF NOT EXISTS signal_scores (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      mint_address          TEXT NOT NULL,
      evaluated_at          INTEGER DEFAULT (unixepoch()),
      dip_score             REAL,
      price_action_score    REAL,
      volume_surge_score    REAL,
      smart_money_score     REAL,
      composite_score       REAL,
      dip_details           TEXT,
      price_action_details  TEXT,
      volume_surge_details  TEXT,
      smart_money_details   TEXT
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
      raw_response   TEXT
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
      mode                 TEXT DEFAULT 'live'
    );

    CREATE TABLE IF NOT EXISTS positions (
      id                       INTEGER PRIMARY KEY AUTOINCREMENT,
      mint_address             TEXT NOT NULL UNIQUE,
      symbol                   TEXT,
      opened_at                INTEGER DEFAULT (unixepoch()),
      closed_at                INTEGER,
      entry_price_usd          REAL,
      exit_price_usd           REAL,
      sol_invested             REAL,
      token_amount             TEXT,
      sol_returned             REAL,
      pnl_usd                  REAL,
      pnl_pct                  REAL,
      exit_reason              TEXT,
      exit_handler             TEXT,
      strategy_order_id        TEXT,
      entry_holder_count       INTEGER,
      entry_smart_wallet_count INTEGER,
      entry_signal_score_id    INTEGER REFERENCES signal_scores(id),
      peak_price_usd           REAL,
      status                   TEXT DEFAULT 'open',
      mode                     TEXT DEFAULT 'live'
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

  migrateSignalScoresColumns(db);
  migratePositionsColumns(db);
  migrateModeColumn(db);
}

/**
 * Migrasi signal_scores dari skema lama (momentum_score / momentum_details)
 * ke skema baru (price_action_score + volume_surge_score / ..._details).
 *
 * CREATE TABLE IF NOT EXISTS tidak menyentuh tabel yang sudah ada, jadi DB
 * lama (dibuat sebelum migrasi ini) masih punya kolom momentum_score/details
 * dan BELUM punya price_action_score/volume_surge_score. Migrasi ini
 * menambahkan kolom baru yang hilang secara idempotent — data historis di
 * momentum_score/momentum_details TIDAK di-backfill (tidak ada cara valid
 * memecah nilai momentum lama jadi price_action vs volume_surge secara
 * retroaktif), kolom lama dibiarkan apa adanya untuk referensi historis.
 */
function migrateSignalScoresColumns(db: Database.Database): void {
  const columns = db.prepare(`PRAGMA table_info(signal_scores)`).all() as Array<{ name: string }>;
  const columnNames = new Set(columns.map((c) => c.name));

  if (!columnNames.has('price_action_score')) {
    db.exec(`ALTER TABLE signal_scores ADD COLUMN price_action_score REAL`);
    logger.info('db_migration', { table: 'signal_scores', added_column: 'price_action_score' });
  }
  if (!columnNames.has('volume_surge_score')) {
    db.exec(`ALTER TABLE signal_scores ADD COLUMN volume_surge_score REAL`);
    logger.info('db_migration', { table: 'signal_scores', added_column: 'volume_surge_score' });
  }
  if (!columnNames.has('price_action_details')) {
    db.exec(`ALTER TABLE signal_scores ADD COLUMN price_action_details TEXT`);
    logger.info('db_migration', { table: 'signal_scores', added_column: 'price_action_details' });
  }
  if (!columnNames.has('volume_surge_details')) {
    db.exec(`ALTER TABLE signal_scores ADD COLUMN volume_surge_details TEXT`);
    logger.info('db_migration', { table: 'signal_scores', added_column: 'volume_surge_details' });
  }
  // momentum_score / momentum_details kolom lama SENGAJA tidak dihapus —
  // SQLite DROP COLUMN aman di versi baru, tapi menghapus data historis
  // yang mungkin masih ingin diaudit. Kolom ini simpel jadi NULL untuk
  // baris baru karena insertSignalScores() tidak lagi menulis ke situ.
}

/**
 * Tambah entry_signal_score_id (FK ke signal_scores.id) ke tabel positions.
 * Menyimpan REFERENSI, bukan snapshot skor — supaya buildPositionPrompt bisa
 * JOIN ke signal_scores dan baca skor entry asli apa adanya, tanpa duplikasi
 * data yang bisa drift kalau struktur sinyal berubah lagi di masa depan.
 * Posisi lama (dibuat sebelum migrasi ini) akan punya entry_signal_score_id
 * NULL — buildPositionPrompt harus menangani kasus ini secara graceful.
 */
function migratePositionsColumns(db: Database.Database): void {
  const columns = db.prepare(`PRAGMA table_info(positions)`).all() as Array<{ name: string }>;
  const columnNames = new Set(columns.map((c) => c.name));

  if (!columnNames.has('entry_signal_score_id')) {
    db.exec(`ALTER TABLE positions ADD COLUMN entry_signal_score_id INTEGER REFERENCES signal_scores(id)`);
    logger.info('db_migration', { table: 'positions', added_column: 'entry_signal_score_id' });
  }
}

/**
 * Tambah kolom `mode` (dry_run/live) ke positions dan trades — supaya data
 * dari dua rezim pengukuran yang sangat berbeda karakteristiknya (khususnya
 * exit price: dry-run cuma approximation dari polling, live bisa pakai fill
 * price asli lewat getStrategyOrderHistory) tidak pernah tercampur tanpa
 * bisa dipisahkan lagi.
 *
 * BACKFILL: baris yang sudah ada SEBELUM migrasi ini dibackfill sebagai
 * 'dry_run' secara eksplisit (bukan default schema 'live') — karena semua
 * data historis sejauh ini memang berasal dari test dengan DRY_RUN=true.
 * Kalau ternyata ada histori live tercampur di masa lalu (seharusnya tidak,
 * tapi tidak ada cara memverifikasi ini dari data itu sendiri), backfill ini
 * akan salah — flag ini secara eksplisit sebagai asumsi, bukan fakta terverifikasi.
 */
function migrateModeColumn(db: Database.Database): void {
  const positionsColumns = db.prepare(`PRAGMA table_info(positions)`).all() as Array<{ name: string }>;
  const positionsHasMode = positionsColumns.some((c) => c.name === 'mode');

  if (!positionsHasMode) {
    db.exec(`ALTER TABLE positions ADD COLUMN mode TEXT DEFAULT 'live'`);
    const result = db.prepare(`UPDATE positions SET mode = 'dry_run' WHERE mode = 'live'`).run();
    logger.info('db_migration', {
      table: 'positions',
      added_column: 'mode',
      backfilled_as: 'dry_run',
      rows_backfilled: result.changes,
    });
  }

  const tradesColumns = db.prepare(`PRAGMA table_info(trades)`).all() as Array<{ name: string }>;
  const tradesHasMode = tradesColumns.some((c) => c.name === 'mode');

  if (!tradesHasMode) {
    db.exec(`ALTER TABLE trades ADD COLUMN mode TEXT DEFAULT 'live'`);
    const result = db.prepare(`UPDATE trades SET mode = 'dry_run' WHERE mode = 'live'`).run();
    logger.info('db_migration', {
      table: 'trades',
      added_column: 'mode',
      backfilled_as: 'dry_run',
      rows_backfilled: result.changes,
    });
  }
}
