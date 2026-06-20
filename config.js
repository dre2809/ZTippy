'use strict';

require('dotenv').config();

// ─── Validation ───────────────────────────────────────────────────────────────

const required = [
  'TELEGRAM_BOT_TOKEN',
  'BOT_SEED_PHRASE',
  'ENCRYPTION_KEY',
];

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

if (process.env.ENCRYPTION_KEY.length < 32) {
  throw new Error('ENCRYPTION_KEY must be at least 32 characters');
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN,
    // Telegram user ID of the bot operator — enables DM-only admin commands
    // like /stats_global and /leave_group. Optional; admin commands are
    // simply unavailable if unset.
    ownerId: process.env.BOT_OWNER_TELEGRAM_ID || null,
  },

  zcash: {
    network: process.env.ZCASH_NETWORK || 'mainnet',
    lightwalletdUrl: process.env.LIGHTWALLETD_URL || 'grpc://localhost:9067',
    seedPhrase: process.env.BOT_SEED_PHRASE,
  },

  community: {
    // Display name shown in /help and bot messages — no UUID needed.
    // Every Telegram group the bot is added to is automatically its own
    // scope for leaderboards/settings (keyed by group_id in the DB).
    name: process.env.BOT_DISPLAY_NAME || 'Zcash Ambassadors',
  },

  tips: {
    minZatoshis: parseInt(process.env.MIN_TIP_ZATOSHIS || '10000', 10),
    // No hard maximum — large tips are allowed, but require explicit
    // confirmation above the threshold below (whichever is reached first:
    // a fixed ZEC amount, or a USD-equivalent amount via live price).
    largeTipZecThreshold: parseFloat(process.env.LARGE_TIP_ZEC_THRESHOLD || '0.05'),
    largeTipUsdThreshold: parseFloat(process.env.LARGE_TIP_USD_THRESHOLD || '50'),
    rainMaxUsers: parseInt(process.env.RAIN_MAX_USERS || '20', 10),
  },

  price: {
    // CoinGecko's public API — no key required for basic price lookups.
    coingeckoUrl: process.env.COINGECKO_API_URL || 'https://api.coingecko.com/api/v3',
    // How long a fetched ZEC/USD price is considered fresh before
    // re-fetching. Keeps the bot well under CoinGecko's free-tier rate
    // limits even with many simultaneous tips across many groups.
    cacheTtlSecs: parseInt(process.env.PRICE_CACHE_TTL_SECS || '120', 10),
  },

  security: {
    withdrawalCooldownSecs: parseInt(process.env.WITHDRAWAL_COOLDOWN_SECS || '600', 10),
    withdrawalConfirmTimeoutSecs: parseInt(process.env.WITHDRAWAL_CONFIRM_TIMEOUT_SECS || '60', 10),
    tipRateLimitPerMinute: parseInt(process.env.TIP_RATE_LIMIT_PER_MINUTE || '10', 10),
    encryptionKey: process.env.ENCRYPTION_KEY,
  },

  db: {
    path: process.env.DB_PATH || './data/tipbot.sqlite3',
  },

  log: {
    level: process.env.LOG_LEVEL || 'info',
    file: process.env.LOG_FILE || './data/tipbot.log',
  },

  // Zcash constants
  zec: {
    ZATOSHIS_PER_ZEC: 100_000_000n,
    // ZIP-317 fee model: 5000 zatoshis per logical action
    MARGINAL_FEE: 5000n,
    // Typical Orchard shielded send = 2 actions (1 input + 1 output)
    DEFAULT_ACTIONS: 2n,
  },
};
