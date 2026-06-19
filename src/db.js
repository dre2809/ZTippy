'use strict';

const Database = require('better-sqlite3');
const config = require('./config');
const logger = require('./logger');
const path = require('path');
const fs = require('fs');

// Ensure data directory exists
const dbDir = path.dirname(config.db.path);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(config.db.path);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');

// ─── Schema Migrations ────────────────────────────────────────────────────────

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_versions (
      version   INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  const migrations = [
    // v1: Core tables
    () => db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        telegram_id    TEXT PRIMARY KEY,
        username       TEXT,
        first_name     TEXT,
        div_index      INTEGER UNIQUE NOT NULL,
        ua_address     TEXT UNIQUE NOT NULL,
        balance_zats   INTEGER DEFAULT 0 CHECK(balance_zats >= 0),
        registered_at  INTEGER NOT NULL,
        last_active_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS tips (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        from_id       TEXT NOT NULL REFERENCES users(telegram_id),
        to_id         TEXT NOT NULL REFERENCES users(telegram_id),
        amount_zats   INTEGER NOT NULL CHECK(amount_zats > 0),
        memo_json     TEXT,
        txid          TEXT,
        group_id      TEXT,
        group_title   TEXT,
        created_at    INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS withdrawals (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id     TEXT NOT NULL REFERENCES users(telegram_id),
        to_address      TEXT NOT NULL,
        amount_zats     INTEGER NOT NULL CHECK(amount_zats > 0),
        fee_zats        INTEGER NOT NULL DEFAULT 0,
        txid            TEXT,
        status          TEXT DEFAULT 'pending' CHECK(status IN ('pending','awaiting_confirm','broadcast','confirmed','failed')),
        failure_reason  TEXT,
        created_at      INTEGER NOT NULL,
        confirmed_at    INTEGER
      );

      CREATE TABLE IF NOT EXISTS group_settings (
        group_id         TEXT PRIMARY KEY,
        group_title      TEXT,
        min_tip_zats     INTEGER DEFAULT 10000,
        admin_ids        TEXT,  -- JSON array of admin telegram_ids
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pending_confirmations (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id     TEXT NOT NULL,
        type            TEXT NOT NULL CHECK(type IN ('withdrawal')),
        payload_json    TEXT NOT NULL,
        expires_at      INTEGER NOT NULL,
        created_at      INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tips_from_id    ON tips(from_id);
      CREATE INDEX IF NOT EXISTS idx_tips_to_id      ON tips(to_id);
      CREATE INDEX IF NOT EXISTS idx_tips_group_id   ON tips(group_id);
      CREATE INDEX IF NOT EXISTS idx_tips_created_at ON tips(created_at);
      CREATE INDEX IF NOT EXISTS idx_withdrawals_telegram_id ON withdrawals(telegram_id);
      CREATE INDEX IF NOT EXISTS idx_withdrawals_status      ON withdrawals(status);
    `),
  ];

  const currentVersion = db.prepare('SELECT MAX(version) as v FROM schema_versions').get().v || 0;

  for (let i = currentVersion; i < migrations.length; i++) {
    logger.info(`Applying DB migration v${i + 1}...`);
    const applyMigration = db.transaction(() => {
      migrations[i]();
      db.prepare('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)').run(i + 1, Date.now());
    });
    applyMigration();
    logger.info(`Migration v${i + 1} applied.`);
  }
}

// ─── User Queries ─────────────────────────────────────────────────────────────

const userQueries = {
  findById: db.prepare('SELECT * FROM users WHERE telegram_id = ?'),
  findByUsername: db.prepare('SELECT * FROM users WHERE username = ?'),
  findByAddress: db.prepare('SELECT * FROM users WHERE ua_address = ?'),

  getMaxDivIndex: db.prepare('SELECT MAX(div_index) as max_idx FROM users'),

  create: db.prepare(`
    INSERT INTO users (telegram_id, username, first_name, div_index, ua_address, balance_zats, registered_at, last_active_at)
    VALUES (@telegram_id, @username, @first_name, @div_index, @ua_address, 0, @registered_at, @registered_at)
  `),

  updateUsername: db.prepare(`
    UPDATE users SET username = ?, first_name = ?, last_active_at = ? WHERE telegram_id = ?
  `),

  updateLastActive: db.prepare('UPDATE users SET last_active_at = ? WHERE telegram_id = ?'),

  updateBalance: db.prepare('UPDATE users SET balance_zats = balance_zats + ? WHERE telegram_id = ?'),

  getTopTippers: db.prepare(`
    SELECT u.username, u.first_name, SUM(t.amount_zats) as total_sent
    FROM tips t JOIN users u ON t.from_id = u.telegram_id
    WHERE t.group_id = ? AND t.created_at >= ?
    GROUP BY t.from_id
    ORDER BY total_sent DESC
    LIMIT 5
  `),

  getTopReceivers: db.prepare(`
    SELECT u.username, u.first_name, SUM(t.amount_zats) as total_received
    FROM tips t JOIN users u ON t.to_id = u.telegram_id
    WHERE t.group_id = ? AND t.created_at >= ?
    GROUP BY t.to_id
    ORDER BY total_received DESC
    LIMIT 5
  `),

  getRecentActiveInGroup: db.prepare(`
    SELECT DISTINCT u.telegram_id, u.username, u.first_name
    FROM tips t
    JOIN users u ON (t.from_id = u.telegram_id OR t.to_id = u.telegram_id)
    WHERE t.group_id = ? AND t.created_at >= ?
    ORDER BY t.created_at DESC
    LIMIT ?
  `),
};

// ─── Tip Queries ──────────────────────────────────────────────────────────────

const tipQueries = {
  insert: db.prepare(`
    INSERT INTO tips (from_id, to_id, amount_zats, memo_json, group_id, group_title, created_at)
    VALUES (@from_id, @to_id, @amount_zats, @memo_json, @group_id, @group_title, @created_at)
  `),

  getHistory: db.prepare(`
    SELECT
      t.*,
      uf.username as from_username, uf.first_name as from_first_name,
      ut.username as to_username, ut.first_name as to_first_name
    FROM tips t
    JOIN users uf ON t.from_id = uf.telegram_id
    JOIN users ut ON t.to_id = ut.telegram_id
    WHERE t.from_id = ? OR t.to_id = ?
    ORDER BY t.created_at DESC
    LIMIT 10
  `),

  getStats: db.prepare(`
    SELECT
      (SELECT COALESCE(SUM(amount_zats),0) FROM tips WHERE from_id = ?) as total_sent,
      (SELECT COALESCE(SUM(amount_zats),0) FROM tips WHERE to_id = ?) as total_received,
      (SELECT COUNT(*) FROM tips WHERE from_id = ?) as sent_count,
      (SELECT COUNT(*) FROM tips WHERE to_id = ?) as received_count,
      (SELECT COALESCE(MAX(amount_zats),0) FROM tips WHERE to_id = ?) as largest_received
  `),
};

// ─── Withdrawal Queries ───────────────────────────────────────────────────────

const withdrawalQueries = {
  insert: db.prepare(`
    INSERT INTO withdrawals (telegram_id, to_address, amount_zats, fee_zats, status, created_at)
    VALUES (@telegram_id, @to_address, @amount_zats, @fee_zats, 'pending', @created_at)
  `),

  updateStatus: db.prepare(`
    UPDATE withdrawals SET status = ?, txid = ?, failure_reason = ?, confirmed_at = ?
    WHERE id = ?
  `),

  getLastWithdrawal: db.prepare(`
    SELECT * FROM withdrawals WHERE telegram_id = ? ORDER BY created_at DESC LIMIT 1
  `),

  getPending: db.prepare(`SELECT * FROM withdrawals WHERE status = 'broadcast'`),
};

// ─── Group Settings Queries ───────────────────────────────────────────────────

const groupQueries = {
  get: db.prepare('SELECT * FROM group_settings WHERE group_id = ?'),

  upsert: db.prepare(`
    INSERT INTO group_settings (group_id, group_title, min_tip_zats, admin_ids, created_at, updated_at)
    VALUES (@group_id, @group_title, @min_tip_zats, @admin_ids, @now, @now)
    ON CONFLICT(group_id) DO UPDATE SET
      group_title = excluded.group_title,
      min_tip_zats = excluded.min_tip_zats,
      admin_ids = excluded.admin_ids,
      updated_at = excluded.updated_at
  `),

  setMinTip: db.prepare('UPDATE group_settings SET min_tip_zats = ?, updated_at = ? WHERE group_id = ?'),
};

// ─── Pending Confirmation Queries ─────────────────────────────────────────────

const confirmationQueries = {
  insert: db.prepare(`
    INSERT INTO pending_confirmations (telegram_id, type, payload_json, expires_at, created_at)
    VALUES (@telegram_id, @type, @payload_json, @expires_at, @created_at)
  `),

  get: db.prepare(`
    SELECT * FROM pending_confirmations
    WHERE telegram_id = ? AND type = ? AND expires_at > ?
    ORDER BY created_at DESC LIMIT 1
  `),

  delete: db.prepare('DELETE FROM pending_confirmations WHERE telegram_id = ? AND type = ?'),

  cleanExpired: db.prepare('DELETE FROM pending_confirmations WHERE expires_at <= ?'),
};

// ─── Atomic Tip Transaction ───────────────────────────────────────────────────

const executeTip = db.transaction((fromId, toId, amountZats, tipData) => {
  // Debit sender
  const debit = db.prepare('UPDATE users SET balance_zats = balance_zats - ? WHERE telegram_id = ? AND balance_zats >= ?');
  const debitResult = debit.run(amountZats, fromId, amountZats);
  if (debitResult.changes === 0) {
    throw new Error('INSUFFICIENT_BALANCE');
  }
  // Credit receiver
  db.prepare('UPDATE users SET balance_zats = balance_zats + ? WHERE telegram_id = ?').run(amountZats, toId);
  // Record tip
  tipQueries.insert.run(tipData);
  // Update last active
  const now = Date.now();
  userQueries.updateLastActive.run(now, fromId);
  userQueries.updateLastActive.run(now, toId);
});

// ─── Atomic Withdrawal Debit ──────────────────────────────────────────────────

const executeWithdrawalDebit = db.transaction((telegramId, amountZats, feeZats, withdrawalData) => {
  const totalZats = amountZats + feeZats;
  const debit = db.prepare('UPDATE users SET balance_zats = balance_zats - ? WHERE telegram_id = ? AND balance_zats >= ?');
  const result = debit.run(totalZats, telegramId, totalZats);
  if (result.changes === 0) {
    throw new Error('INSUFFICIENT_BALANCE');
  }
  const insertResult = withdrawalQueries.insert.run(withdrawalData);
  return insertResult.lastInsertRowid;
});

module.exports = {
  migrate,
  db,
  users: userQueries,
  tips: tipQueries,
  withdrawals: withdrawalQueries,
  groups: groupQueries,
  confirmations: confirmationQueries,
  executeTip,
  executeWithdrawalDebit,
};
