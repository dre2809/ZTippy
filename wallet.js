'use strict';

/**
 * wallet.js — Zcash wallet interface
 *
 * This module provides the interface between the bot and the Zcash network.
 *
 * PRODUCTION NOTE:
 * In production this module calls librustzcash via a native Node.js addon
 * (zcash_client_backend, zcash_keys, zcash_address, orchard crates) compiled
 * with napi-rs or node-bindgen.
 *
 * For testnet / development, the MOCK_WALLET=true env var activates the
 * deterministic mock implementation below so the bot can be tested without
 * a running zebrad + lightwalletd stack.
 *
 * Integration points for production:
 *   - Replace deriveAddress()   → zcash_keys::keys::UnifiedSpendingKey::from_seed() + diversify()
 *   - Replace broadcastTx()     → lightwalletd gRPC SendTransaction()
 *   - Replace getConfirmed()    → lightwalletd gRPC GetLatestBlock() + wallet scan
 *   - Replace validateAddress() → zcash_address::ZcashAddress::try_from_encoded()
 */

const config = require('./config');
const logger = require('./logger');
const CryptoJS = require('crypto-js');

const MOCK = process.env.MOCK_WALLET === 'true' || process.env.NODE_ENV === 'test';

// ─── Native Addon Loading ──────────────────────────────────────────────────────
//
// Attempts to load the compiled Rust addon (native/). If it isn't built yet
// (e.g. local dev without Rust ≥ 1.85), falls back to MOCK behavior with a
// warning, rather than crashing the whole bot on startup.

let native = null;
if (!MOCK) {
  try {
    native = require('../native');
    logger.info(`Native wallet addon loaded: ${native.version()}`);
  } catch (err) {
    logger.warn(`Native addon not available (${err.message}). Falling back to mock wallet.`);
  }
}

const NATIVE_AVAILABLE = native !== null;

// ─── Constants ────────────────────────────────────────────────────────────────

const { MARGINAL_FEE, DEFAULT_ACTIONS, ZATOSHIS_PER_ZEC } = config.zec;

// ─── Address Validation ───────────────────────────────────────────────────────

/**
 * Validates a Zcash Unified Address.
 * Uses the native addon's zcash_address-backed validator when available;
 * falls back to a structural bech32m check otherwise.
 */
function validateUnifiedAddress(address) {
  if (typeof address !== 'string') return false;

  if (NATIVE_AVAILABLE) {
    const result = native.validateAddress(address, config.zcash.network);
    return result.valid;
  }

  // Fallback structural check (mock / addon-not-built path)
  const network = config.zcash.network;
  if (network === 'mainnet' && address.startsWith('u1')) {
    return address.length >= 43 && /^u1[a-z0-9]+$/.test(address);
  }
  if (network === 'testnet' && address.startsWith('utest')) {
    return address.length >= 43 && /^utest[a-z0-9]+$/.test(address);
  }
  return false;
}

/**
 * Rejects transparent (t1...) and Sapling (zs1...) addresses.
 * Only Unified Addresses are accepted.
 *
 * Uses the native addon's typed AddressValidationResult when available —
 * gives precise rejection reasons (transparent vs Sapling vs malformed)
 * instead of a generic message.
 */
function rejectNonUA(address) {
  if (NATIVE_AVAILABLE) {
    const result = native.validateAddress(address, config.zcash.network);
    return { valid: result.valid, reason: result.reason || undefined };
  }

  // Fallback (mock / addon-not-built path)
  if (address.startsWith('t1') || address.startsWith('t3')) {
    return { valid: false, reason: 'Transparent addresses are not accepted. Please use a Unified Address (u1...).' };
  }
  if (address.startsWith('zs1')) {
    return { valid: false, reason: 'Sapling addresses are not accepted. Please use a Unified Address (u1...).' };
  }
  if (!validateUnifiedAddress(address)) {
    return { valid: false, reason: 'Invalid address format. Please provide a valid Zcash Unified Address starting with u1...' };
  }
  return { valid: true };
}

// ─── ZIP-317 Fee Calculation ──────────────────────────────────────────────────

/**
 * Calculates the ZIP-317 fee for a transaction.
 * fee = marginal_fee × max(2, logical_actions)
 * For a standard shielded-to-shielded Orchard send: 2 actions.
 * For a /rain with n recipients: n + 1 actions (n outputs + 1 input).
 *
 * Delegates to the native addon's Rust implementation when available
 * (single source of truth shared with the on-chain tx builder).
 *
 * @param {number} numActions - number of logical actions in the transaction
 * @returns {bigint} fee in zatoshis
 */
function calculateFee(numActions = 2) {
  if (NATIVE_AVAILABLE) {
    return BigInt(native.calculateFee(numActions));
  }
  const actions = BigInt(Math.max(2, numActions));
  return MARGINAL_FEE * actions;
}

// ─── Seed Encryption / Decryption ─────────────────────────────────────────────

function encryptSeed(seed) {
  return CryptoJS.AES.encrypt(seed, config.security.encryptionKey).toString();
}

function decryptSeed(ciphertext) {
  const bytes = CryptoJS.AES.decrypt(ciphertext, config.security.encryptionKey);
  return bytes.toString(CryptoJS.enc.Utf8);
}

// ─── Address Derivation ───────────────────────────────────────────────────────

/**
 * Derives a ZIP-316 Unified Address at the given diversifier index.
 *
 * Uses the native addon's deriveUnifiedAddress() when available, which
 * derives a real Orchard diversified receiver from the bot's seed.
 * Falls back to a deterministic mock address otherwise.
 *
 * The diversifier index uniquely identifies each user's address.
 * Index 0 is reserved for the bot's own deposit address.
 */
async function deriveAddress(diversifierIndex) {
  if (MOCK || !NATIVE_AVAILABLE) {
    return mockDeriveAddress(diversifierIndex);
  }

  const seedHex = getSeedHex();
  return native.deriveUnifiedAddress(seedHex, String(diversifierIndex), config.zcash.network);
}

/**
 * Returns the bot's seed as a hex string, decrypting from the encrypted
 * store if present, or deriving directly from the configured mnemonic.
 *
 * Cached after first call — the seed should only be derived once at startup.
 */
let _seedHexCache = null;
function getSeedHex() {
  if (_seedHexCache) return _seedHexCache;
  if (!NATIVE_AVAILABLE) {
    throw new Error('Native addon required to derive seed. Set MOCK_WALLET=true or build the addon.');
  }
  _seedHexCache = native.phraseToSeedHex(config.zcash.seedPhrase);
  return _seedHexCache;
}

/**
 * Builds the memo payload for a tip or withdrawal.
 * Max 512 bytes UTF-8 per ZIP-302.
 *
 * Uses the native addon's encodeMemo() when available, which produces
 * the exact 512-byte null-padded buffer that goes on-chain. For off-chain
 * tips (stored only in SQLite) the JSON string form is sufficient either way.
 */
function buildMemo({ type, fromHandle, toHandle, groupName, communityUuid, message }) {
  if (NATIVE_AVAILABLE) {
    // Native addon returns the full 512-byte hex-encoded memo.
    // We store the JSON-only portion in SQLite for readability/search,
    // but the hex form is what actually gets embedded on-chain at broadcast time.
    return native.encodeMemo(type, fromHandle || null, toHandle || null, groupName || null, communityUuid, message || null);
  }

  const memo = {
    v: 1,
    type,
    from: fromHandle ? `@${fromHandle}` : undefined,
    to: toHandle ? `@${toHandle}` : undefined,
    group: groupName,
    community: communityUuid,
    msg: message || undefined,
  };

  Object.keys(memo).forEach(k => memo[k] === undefined && delete memo[k]);

  const memoStr = JSON.stringify(memo);
  if (Buffer.byteLength(memoStr, 'utf8') > 512) {
    delete memo.msg;
  }
  return JSON.stringify(memo);
}

// ─── Transaction Broadcasting ─────────────────────────────────────────────────

/**
 * Broadcasts a shielded Orchard withdrawal transaction via lightwalletd.
 *
 * PRODUCTION: Replace with gRPC call to lightwalletd SendTransaction.
 * Uses Orchard pool exclusively (ZIP-224, Halo 2 proving).
 *
 * @param {object} params
 * @param {string} params.toAddress - destination u1... address
 * @param {bigint} params.amountZats - amount in zatoshis
 * @param {bigint} params.feeZats - fee in zatoshis (ZIP-317)
 * @param {string} params.memo - encoded memo string
 * @returns {Promise<{txid: string}>}
 */
async function broadcastWithdrawal({ toAddress, amountZats, feeZats, memo }) {
  if (MOCK) {
    return mockBroadcast({ toAddress, amountZats, feeZats, memo });
  }

  // Production implementation:
  // const wallet = require('../native/zcash_wallet.node');
  // const grpc = require('./lightwalletd_client');
  // const seed = decryptSeed(config.zcash.encryptedSeed);
  // const rawTx = await wallet.buildOrchardTx({ seed, toAddress, amountZats, feeZats, memo, network: config.zcash.network });
  // const result = await grpc.sendTransaction(rawTx);
  // return { txid: result.errorCode === 0 ? result.errorMessage : null };
  throw new Error('Production wallet not configured.');
}

/**
 * Returns the bot wallet's total confirmed balance from lightwalletd.
 * Used for reconciliation — internal SQLite balances are the source of truth for users.
 */
async function getBotBalance() {
  if (MOCK) return { confirmedZats: 50_000_000n, unconfirmedZats: 0n };

  // Production: scan via lightwalletd GetBalance or wallet sync
  throw new Error('Production wallet not configured.');
}

// ─── Mock Implementations (dev/test only) ────────────────────────────────────

let mockDivCounter = 0;

function mockDeriveAddress(diversifierIndex) {
  // Generates deterministic fake u1... addresses for testing
  const network = config.zcash.network;
  const prefix = network === 'mainnet' ? 'u1' : 'utest';
  const body = `mock${String(diversifierIndex).padStart(6, '0')}${'a'.repeat(37)}`;
  return `${prefix}${body}`;
}

function mockBroadcast({ toAddress, amountZats }) {
  const txid = 'mock_txid_' + Math.random().toString(36).slice(2, 18);
  logger.debug(`[MOCK] Broadcast tx: ${amountZats} zats → ${toAddress} | txid: ${txid}`);
  return Promise.resolve({ txid });
}

// ─── Utility Conversions ──────────────────────────────────────────────────────

function zatsToZec(zats) {
  const bigZats = BigInt(zats);
  const whole = bigZats / ZATOSHIS_PER_ZEC;
  const frac = bigZats % ZATOSHIS_PER_ZEC;
  return `${whole}.${String(frac).padStart(8, '0').replace(/0+$/, '') || '0'}`;
}

function zecToZats(zec) {
  const [whole, frac = ''] = String(zec).split('.');
  const fracPadded = frac.padEnd(8, '0').slice(0, 8);
  return BigInt(whole) * ZATOSHIS_PER_ZEC + BigInt(fracPadded);
}

function formatZec(zats) {
  return `${zatsToZec(zats)} ZEC`;
}

module.exports = {
  validateUnifiedAddress,
  rejectNonUA,
  calculateFee,
  deriveAddress,
  buildMemo,
  broadcastWithdrawal,
  getBotBalance,
  encryptSeed,
  decryptSeed,
  zatsToZec,
  zecToZats,
  formatZec,
  MOCK,
  NATIVE_AVAILABLE,
};
