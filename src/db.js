'use strict';

/**
 * db.js — Database layer using Turso (libSQL) with embedded replica mode.
 *
 * Uses @libsql/client in embedded replica mode:
 *   - Local SQLite file for synchronous-style reads (fast, no network)
 *   - Syncs to Turso cloud every 30 seconds + on every write
 *   - Both Railway (bot) and VPS (scanner) share the same Turso database
 *
 * The API mirrors better-sqlite3 as closely as possible so the rest of
 * the codebase needs minimal changes.
 */

const { createClient } = require('@libsql/client');
const config = require('./config');
const logger = require('./logger');
const path = require('path');
const fs = require('fs');

// Ensure data directory exists
const dbDir = path.dirname(config.db.path);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// ─── Client Setup ─────────────────────────────────────────────────────────────

const isTurso = !!(process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN);

let client;

if (isTurso) {
  client = createClient({
    url: `file:${config.db.path}`,
    syncUrl: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
    syncInterval: 30,
  });
  logger.info('Database: Turso embedded replica mode');
} else {
  // Local-only fallback (dev/test without Turso)
  client = createClient({ url: `file:${config.db.path}` });
  logger.info('Database: local SQLite mode (no Turso sync)');
}

// ─── Sync Helper ──────────────────────────────────────────────────────────────

async function syncToTurso() {
  if (isTurso && typeof client.sync === 'function') {
    try { await client.sync(); } catch (e) {
      logger.debug('Turso sync error (non-fatal):', e.message);
    }
  }
}

// ─── Query Wrapper ────────────────────────────────────────────────────────────

/**
 * Executes a SQL statement and returns { rows, rowsAffected, lastInsertRowid }.
 * All queries go through this single function.
 */
async function execute(sql, args = []) {
  const result = await client.execute({ sql, args });
  return {
    rows: result.rows,
    changes: result.rowsAffected,
    lastInsertRowid: result.lastInsertRowid ? Number(result.lastInsertRowid) : null,
  };
}

/**
 * Executes multiple statements in a batch (used for migrations).
 */
async function executeBatch(statements) {
  await client.batch(statements.map(sql => ({ sql, args: [] })), 'write');
}

// ─── Schema Migrations ────────────────────────────────────────────────────────

async function migrate() {
  await execute(`CREATE TABLE IF NOT EXISTS schema_versions (
    version    INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`);

  const migrations = [
    // v1: Core tables
    `CREATE TABLE IF NOT EXISTS users (
      telegram_id    TEXT PRIMARY KEY,
      username       TEXT,
      first_name     TEXT,
      div_index      INTEGER UNIQUE NOT NULL,
      ua_address     TEXT UNIQUE NOT NULL,
      balance_zats   INTEGER DEFAULT 0,
      registered_at  INTEGER NOT NULL,
      last_active_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS tips (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      from_id       TEXT NOT NULL,
      to_id         TEXT NOT NULL,
      amount_zats   INTEGER NOT NULL,
      memo_json     TEXT,
      txid          TEXT,
      group_id      TEXT,
      group_title   TEXT,
      created_at    INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS withdrawals (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id     TEXT NOT NULL,
      to_address      TEXT NOT NULL,
      amount_zats     INTEGER NOT NULL,
      fee_zats        INTEGER NOT NULL DEFAULT 0,
      txid            TEXT,
      status          TEXT DEFAULT 'pending',
      failure_reason  TEXT,
      created_at      INTEGER NOT NULL,
      confirmed_at    INTEGER
    );
    CREATE TABLE IF NOT EXISTS group_settings (
      group_id         TEXT PRIMARY KEY,
      group_title      TEXT,
      min_tip_zats     INTEGER DEFAULT 10000,
      admin_ids        TEXT,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pending_confirmations (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id     TEXT NOT NULL,
      type            TEXT NOT NULL,
      payload_json    TEXT NOT NULL,
      expires_at      INTEGER NOT NULL,
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tips_from_id    ON tips(from_id);
    CREATE INDEX IF NOT EXISTS idx_tips_to_id      ON tips(to_id);
    CREATE INDEX IF NOT EXISTS idx_tips_group_id   ON tips(group_id);
    CREATE INDEX IF NOT EXISTS idx_tips_created_at ON tips(created_at);
    CREATE INDEX IF NOT EXISTS idx_withdrawals_telegram_id ON withdrawals(telegram_id);
    CREATE INDEX IF NOT EXISTS idx_withdrawals_status      ON withdrawals(status)`,

    // v2: pending_confirmations already created above with correct schema

    // v3: Deposits table
    `CREATE TABLE IF NOT EXISTS deposits (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id   TEXT NOT NULL,
      txid          TEXT NOT NULL,
      amount_zats   INTEGER NOT NULL,
      block_height  INTEGER,
      credited_at   INTEGER NOT NULL,
      UNIQUE(telegram_id, txid)
    );
    CREATE INDEX IF NOT EXISTS idx_deposits_telegram_id ON deposits(telegram_id);
    CREATE INDEX IF NOT EXISTS idx_deposits_txid ON deposits(txid)`,

    // v4: Pending balances — tips sent to unregistered users (stored by username)
    `CREATE TABLE IF NOT EXISTS pending_balances (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      to_username   TEXT NOT NULL,
      from_id       TEXT NOT NULL,
      amount_zats   INTEGER NOT NULL,
      group_id      TEXT,
      group_title   TEXT,
      created_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pending_balances_username ON pending_balances(to_username)`,
  ];

  const result = await execute('SELECT MAX(version) as v FROM schema_versions');
  const currentVersion = result.rows[0]?.v ?? 0;

  for (let i = currentVersion; i < migrations.length; i++) {
    logger.info(`Applying DB migration v${i + 1}...`);
    // Split on semicolons and run each statement
    const stmts = migrations[i].split(';').map(s => s.trim()).filter(Boolean);
    for (const stmt of stmts) {
      await execute(stmt);
    }
    await execute(
      'INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)',
      [i + 1, Date.now()]
    );
    logger.info(`Migration v${i + 1} applied.`);
  }

  await syncToTurso();
}

// ─── Query Helpers ────────────────────────────────────────────────────────────
// These match the better-sqlite3 API used throughout the codebase,
// but return Promises instead of synchronous values.

const users = {
  findById: (id) => execute('SELECT * FROM users WHERE telegram_id = ?', [id])
    .then(r => r.rows[0] || null),

  findByUsername: (username) => execute('SELECT * FROM users WHERE username = ?', [username])
    .then(r => r.rows[0] || null),

  findByAddress: (addr) => execute('SELECT * FROM users WHERE ua_address = ?', [addr])
    .then(r => r.rows[0] || null),

  getMaxDivIndex: () => execute('SELECT MAX(div_index) as max_idx FROM users')
    .then(r => ({ max_idx: r.rows[0]?.max_idx ?? null })),

  create: (data) => execute(
    `INSERT INTO users (telegram_id, username, first_name, div_index, ua_address, balance_zats, registered_at, last_active_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
    [data.telegram_id, data.username, data.first_name, data.div_index,
     data.ua_address, data.registered_at, data.registered_at]
  ).then(r => { syncToTurso(); return r; }),

  updateUsername: (username, firstName, now, id) => execute(
    'UPDATE users SET username = ?, first_name = ?, last_active_at = ? WHERE telegram_id = ?',
    [username, firstName, now, id]
  ),

  updateLastActive: (now, id) => execute(
    'UPDATE users SET last_active_at = ? WHERE telegram_id = ?', [now, id]
  ),

  getTopTippers: (groupId, since) => execute(
    `SELECT u.username, u.first_name, SUM(t.amount_zats) as total_sent
     FROM tips t JOIN users u ON t.from_id = u.telegram_id
     WHERE t.group_id = ? AND t.created_at >= ?
     GROUP BY t.from_id ORDER BY total_sent DESC LIMIT 5`,
    [groupId, since]
  ).then(r => r.rows),

  getTopReceivers: (groupId, since) => execute(
    `SELECT u.username, u.first_name, SUM(t.amount_zats) as total_received
     FROM tips t JOIN users u ON t.to_id = u.telegram_id
     WHERE t.group_id = ? AND t.created_at >= ?
     GROUP BY t.to_id ORDER BY total_received DESC LIMIT 5`,
    [groupId, since]
  ).then(r => r.rows),

  getRecentActiveInGroup: (groupId, since, limit) => execute(
    `SELECT DISTINCT u.telegram_id, u.username, u.first_name
     FROM tips t JOIN users u ON (t.from_id = u.telegram_id OR t.to_id = u.telegram_id)
     WHERE t.group_id = ? AND t.created_at >= ?
     ORDER BY t.created_at DESC LIMIT ?`,
    [groupId, since, limit]
  ).then(r => r.rows),
};

const tips = {
  insert: (data) => execute(
    `INSERT INTO tips (from_id, to_id, amount_zats, memo_json, group_id, group_title, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [data.from_id, data.to_id, data.amount_zats, data.memo_json,
     data.group_id, data.group_title, data.created_at]
  ).then(r => { syncToTurso(); return r; }),

  getHistory: (id) => execute(
    `SELECT t.*,
       uf.username as from_username, uf.first_name as from_first_name,
       ut.username as to_username, ut.first_name as to_first_name
     FROM tips t
     JOIN users uf ON t.from_id = uf.telegram_id
     JOIN users ut ON t.to_id = ut.telegram_id
     WHERE t.from_id = ? OR t.to_id = ?
     ORDER BY t.created_at DESC LIMIT 10`,
    [id, id]
  ).then(r => r.rows),

  getStats: (id) => execute(
    `SELECT
       (SELECT COALESCE(SUM(amount_zats),0) FROM tips WHERE from_id = ?) as total_sent,
       (SELECT COALESCE(SUM(amount_zats),0) FROM tips WHERE to_id = ?)   as total_received,
       (SELECT COUNT(*) FROM tips WHERE from_id = ?)                      as sent_count,
       (SELECT COUNT(*) FROM tips WHERE to_id = ?)                        as received_count,
       (SELECT COALESCE(MAX(amount_zats),0) FROM tips WHERE to_id = ?)   as largest_received`,
    [id, id, id, id, id]
  ).then(r => r.rows[0]),
};

const withdrawals = {
  insert: (data) => execute(
    `INSERT INTO withdrawals (telegram_id, to_address, amount_zats, fee_zats, status, created_at)
     VALUES (?, ?, ?, ?, 'pending', ?)`,
    [data.telegram_id, data.to_address, data.amount_zats, data.fee_zats, data.created_at]
  ).then(r => { syncToTurso(); return r; }),

  updateStatus: (status, txid, failureReason, confirmedAt, id) => execute(
    'UPDATE withdrawals SET status = ?, txid = ?, failure_reason = ?, confirmed_at = ? WHERE id = ?',
    [status, txid, failureReason, confirmedAt, id]
  ).then(r => { syncToTurso(); return r; }),

  getLastWithdrawal: (id) => execute(
    'SELECT * FROM withdrawals WHERE telegram_id = ? ORDER BY created_at DESC LIMIT 1', [id]
  ).then(r => r.rows[0] || null),

  getPending: () => execute("SELECT * FROM withdrawals WHERE status = 'broadcast'")
    .then(r => r.rows),
};

const groups = {
  get: (id) => execute('SELECT * FROM group_settings WHERE group_id = ?', [id])
    .then(r => r.rows[0] || null),

  upsert: (data) => execute(
    `INSERT INTO group_settings (group_id, group_title, min_tip_zats, admin_ids, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(group_id) DO UPDATE SET
       group_title = excluded.group_title,
       min_tip_zats = excluded.min_tip_zats,
       admin_ids = excluded.admin_ids,
       updated_at = excluded.updated_at`,
    [data.group_id, data.group_title, data.min_tip_zats, data.admin_ids, data.now, data.now]
  ).then(r => { syncToTurso(); return r; }),

  setMinTip: (minTip, now, groupId) => execute(
    'UPDATE group_settings SET min_tip_zats = ?, updated_at = ? WHERE group_id = ?',
    [minTip, now, groupId]
  ).then(r => { syncToTurso(); return r; }),
};

const confirmations = {
  insert: (data) => execute(
    `INSERT INTO pending_confirmations (telegram_id, type, payload_json, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [data.telegram_id, data.type, data.payload_json, data.expires_at, data.created_at]
  ),

  get: (telegramId, type, now) => execute(
    `SELECT * FROM pending_confirmations
     WHERE telegram_id = ? AND type = ? AND expires_at > ?
     ORDER BY created_at DESC LIMIT 1`,
    [telegramId, type, now]
  ).then(r => r.rows[0] || null),

  delete: (telegramId, type) => execute(
    'DELETE FROM pending_confirmations WHERE telegram_id = ? AND type = ?',
    [telegramId, type]
  ),

  cleanExpired: (now) => execute(
    'DELETE FROM pending_confirmations WHERE expires_at <= ?', [now]
  ),
};

// ─── Atomic Tip Transaction ───────────────────────────────────────────────────

async function executeTip(fromId, toId, amountZats, tipData) {
  // Debit sender
  const debit = await execute(
    'UPDATE users SET balance_zats = balance_zats - ? WHERE telegram_id = ? AND balance_zats >= ?',
    [amountZats, fromId, amountZats]
  );
  if (debit.changes === 0) throw new Error('INSUFFICIENT_BALANCE');

  // Credit receiver
  await execute(
    'UPDATE users SET balance_zats = balance_zats + ? WHERE telegram_id = ?',
    [amountZats, toId]
  );

  // Record tip
  await tips.insert(tipData);

  // Update last active
  const now = Date.now();
  await users.updateLastActive(now, fromId);
  await users.updateLastActive(now, toId);

  await syncToTurso();
}

// ─── Atomic Withdrawal Debit ──────────────────────────────────────────────────

async function executeWithdrawalDebit(telegramId, amountZats, feeZats, withdrawalData) {
  const totalZats = amountZats + feeZats;
  const debit = await execute(
    'UPDATE users SET balance_zats = balance_zats - ? WHERE telegram_id = ? AND balance_zats >= ?',
    [totalZats, telegramId, totalZats]
  );
  if (debit.changes === 0) throw new Error('INSUFFICIENT_BALANCE');

  const result = await withdrawals.insert(withdrawalData);
  await syncToTurso();
  return result.lastInsertRowid;
}

// ─── Raw execute for scanner and bot stats ───────────────────────────────────

const db = { execute, prepare: null };

module.exports = {
  migrate,
  execute,
  syncToTurso,
  db,
  users,
  tips,
  withdrawals,
  groups,
  confirmations,
  executeTip,
  executeWithdrawalDebit,
};
