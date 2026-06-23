'use strict';

/**
 * scanner-standalone.js — Standalone deposit scanner for the VPS.
 *
 * Run this separately on the VPS (not on Railway):
 *   node src/scanner-standalone.js
 *
 * Or as a systemd service (see below).
 *
 * This process:
 *   - Connects to lightwalletd via gRPC (localhost:9067)
 *   - Scans compact blocks for incoming Orchard deposits
 *   - Credits matching user balances in Turso
 *   - Notifies users via Telegram Bot API
 */

require('dotenv').config();

const scanner = require('./scanner');
const logger = require('./logger');
const config = require('./config');
const db = require('./db');

logger.info('Starting ZTippy deposit scanner (standalone)...');
logger.info(`Network: ${config.zcash.network}`);

// Wire up a minimal Telegram client for user notifications
// (no full bot needed — just the telegram API client)
const { Telegraf } = require('telegraf');
const bot = new Telegraf(config.telegram.token);

db.migrate().then(() => {
  logger.info('Database ready');
  scanner.startScanner(bot);
  logger.info('Deposit scanner running — press Ctrl+C to stop');
}).catch(err => {
  logger.error('Failed to start scanner:', err);
  process.exit(1);
});
