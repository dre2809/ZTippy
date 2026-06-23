'use strict';

/**
 * scanner.js — Deposit scanner for ZTippy
 *
 * Scans Zcash compact blocks from lightwalletd to detect incoming
 * shielded deposits to any user's Unified Address.
 *
 * Architecture:
 * - Polls lightwalletd's GetLatestBlock every 30 seconds to detect new blocks
 * - For each new block, calls GetBlock to get compact block data
 * - Uses the native addon's trial-decrypt function to find notes destined
 *   for any of our users' diversified addresses
 * - Credits the matching user's balance in SQLite
 *
 * NOTE: Full Orchard trial-decryption requires the UFVK's incoming viewing key,
 * which is only available via the native Rust addon. Until that function is
 * added to the addon, this scanner uses an alternative approach:
 *
 * CURRENT APPROACH (works now):
 * - Uses zebrad's z_listreceivedbyaddress RPC on each registered user's address
 *   to detect incoming transactions
 * - Checks every registered user's address for new received notes
 * - This works because zebrad tracks our wallet's addresses via the UFVK
 *
 * FUTURE UPGRADE:
 * - Add trial_decrypt() to native addon using zcash_client_backend's
 *   compact block scanner for O(1) per-block scanning instead of
 *   O(n_users) RPC calls per block
 */

const https = require('https');
const http = require('http');
const db = require('./db');
const wallet = require('./wallet');
const config = require('./config');
const logger = require('./logger');

// Track the last scanned block height to avoid re-scanning
let lastScannedHeight = 0;

// Minimum confirmations before crediting a deposit
const MIN_CONFIRMATIONS = 1;

/**
 * Makes a JSON-RPC call to zebrad.
 */
function zebradRpc(method, params = []) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      jsonrpc: '1.0',
      id: 'scanner',
      method,
      params,
    });

    const url = new URL(config.zcash.zebradRpcUrl || 'http://127.0.0.1:8232');
    const options = {
      hostname: url.hostname,
      port: url.port || 8232,
      path: '/',
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': 'Basic ' + Buffer.from(
          `${config.zcash.rpcUser}:${config.zcash.rpcPassword}`
        ).toString('base64'),
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message));
          resolve(parsed.result);
        } catch (e) {
          reject(new Error(`Invalid JSON from zebrad: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('zebrad RPC timeout')));
    req.write(body);
    req.end();
  });
}

/**
 * Gets the current block height from zebrad.
 */
async function getBlockHeight() {
  const info = await zebradRpc('getblockchaininfo');
  return info.blocks;
}

/**
 * Checks a single user's address for new received notes using zebrad's
 * z_listreceivedbyaddress RPC.
 *
 * Returns array of { txid, amount_zats, confirmations } for new deposits.
 */
async function checkAddressForDeposits(uaAddress, minConfirmations = MIN_CONFIRMATIONS) {
  try {
    // z_listreceivedbyaddress returns all received notes for this address
    const received = await zebradRpc('z_listreceivedbyaddress', [uaAddress, minConfirmations]);
    return received || [];
  } catch (err) {
    // Address not in wallet or other error — not a fatal issue
    logger.debug(`z_listreceivedbyaddress failed for ${uaAddress.slice(0, 10)}...: ${err.message}`);
    return [];
  }
}

/**
 * Imports the bot's UFVK into zebrad so it can track all our users' addresses.
 * Called once at startup — idempotent (safe to call multiple times).
 */
async function importUfvk() {
  if (!wallet.NATIVE_AVAILABLE) {
    logger.warn('Scanner: native addon not available, cannot derive UFVK');
    return false;
  }

  try {
    const native = require('../native');
    const seedHex = native.phraseToSeedHex(config.zcash.seedPhrase);
    const ufvk = await native.deriveUfvk(seedHex, config.zcash.network);

    // Import the UFVK into zebrad with wallet birthday
    // rescan=false since we handle our own scanning logic
    await zebradRpc('z_importviewingkey', [ufvk, 'no']);
    logger.info('Scanner: UFVK imported into zebrad successfully');
    return true;
  } catch (err) {
    if (err.message.includes('already have')) {
      logger.debug('Scanner: UFVK already imported in zebrad');
      return true;
    }
    logger.error('Scanner: Failed to import UFVK:', err.message);
    return false;
  }
}

/**
 * Main scan loop — checks all registered users for new deposits.
 *
 * Called every SCAN_INTERVAL_MS milliseconds.
 */
async function scanForDeposits() {
  try {
    const currentHeight = await getBlockHeight();

    if (currentHeight <= lastScannedHeight) {
      return; // No new blocks
    }

    logger.debug(`Scanner: checking deposits up to block ${currentHeight}`);

    // Get all registered users
    const users = await db.execute('SELECT * FROM users WHERE ua_address IS NOT NULL').then(r => r.rows);

    if (users.length === 0) return;

    let totalCredited = 0;

    for (const user of users) {
      const deposits = await checkAddressForDeposits(user.ua_address);

      for (const deposit of deposits) {
        const amountZats = Math.round(deposit.amount * 100_000_000); // ZEC to zatoshis

        if (amountZats <= 0) continue;

        // Check if we've already credited this txid for this user
        const alreadyCredited = await db.execute(
          'SELECT id FROM deposits WHERE telegram_id = ? AND txid = ?',
          [user.telegram_id, deposit.txid]
        ).then(r => r.rows[0] || null);

        if (alreadyCredited) continue;

        // Credit the user's balance
        await db.execute(
          'UPDATE users SET balance_zats = balance_zats + ? WHERE telegram_id = ?',
          [amountZats, user.telegram_id]
        );
        await db.execute(
          'INSERT INTO deposits (telegram_id, txid, amount_zats, block_height, credited_at) VALUES (?, ?, ?, ?, ?)',
          [user.telegram_id, deposit.txid, amountZats, currentHeight, Date.now()]
        );
        await db.syncToTurso();

        totalCredited++;
        logger.info(
          `Scanner: credited ${wallet.formatZec(amountZats)} to @${user.username || user.telegram_id} | txid: ${deposit.txid}`
        );

        // Notify the user via Telegram if bot instance is available
        if (global.botInstance) {
          try {
            await global.botInstance.telegram.sendMessage(
              user.telegram_id,
              [
                `💰 *Deposit received!*`,
                ``,
                `Amount: *${wallet.formatZec(amountZats)}*`,
                `TXID: \`${deposit.txid.slice(0, 16)}...\``,
                ``,
                `Your new balance: *${wallet.formatZec(
                  (await db.users.findById(user.telegram_id)).balance_zats
                )}*`,
              ].join('\n'),
              { parse_mode: 'Markdown' }
            );
          } catch (notifyErr) {
            logger.debug(`Scanner: could not notify user ${user.telegram_id}: ${notifyErr.message}`);
          }
        }
      }
    }

    if (totalCredited > 0) {
      logger.info(`Scanner: credited ${totalCredited} deposit(s) at block ${currentHeight}`);
    }

    lastScannedHeight = currentHeight;
  } catch (err) {
    logger.error('Scanner: scan error:', err.message);
  }
}

/**
 * Starts the deposit scanner background loop.
 * Call this from bot.js after the bot is launched.
 */
function startScanner(botInstance) {
  global.botInstance = botInstance;

  const SCAN_INTERVAL_MS = parseInt(process.env.SCAN_INTERVAL_MS || '30000', 10);

  logger.info(`Scanner: starting deposit scanner (interval: ${SCAN_INTERVAL_MS / 1000}s)`);

  // Import UFVK on startup
  importUfvk().then(success => {
    if (success) {
      logger.info('Scanner: ready — watching for deposits');
    } else {
      logger.warn('Scanner: running without UFVK import — deposits may not be detected');
    }
  });

  // Run immediately, then on interval
  scanForDeposits();
  const interval = setInterval(scanForDeposits, SCAN_INTERVAL_MS);

  // Clean up on shutdown
  process.on('SIGINT', () => clearInterval(interval));
  process.on('SIGTERM', () => clearInterval(interval));

  return interval;
}

module.exports = { startScanner, scanForDeposits, importUfvk };
