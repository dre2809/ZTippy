'use strict';

const { RateLimiterMemory } = require('rate-limiter-flexible');
const config = require('./config');
const logger = require('./logger');

// Tip rate limiter: N tips per user per minute
const tipLimiter = new RateLimiterMemory({
  points: config.security.tipRateLimitPerMinute,
  duration: 60,
});

// Command rate limiter: 30 any-commands per user per minute
const commandLimiter = new RateLimiterMemory({
  points: 30,
  duration: 60,
});

// Registration: 1 per user per 5 minutes
const registerLimiter = new RateLimiterMemory({
  points: 1,
  duration: 300,
});

async function checkTipLimit(telegramId) {
  try {
    await tipLimiter.consume(String(telegramId));
    return true;
  } catch {
    logger.warn(`Tip rate limit hit: ${telegramId}`);
    return false;
  }
}

async function checkCommandLimit(telegramId) {
  try {
    await commandLimiter.consume(String(telegramId));
    return true;
  } catch {
    logger.warn(`Command rate limit hit: ${telegramId}`);
    return false;
  }
}

async function checkRegisterLimit(telegramId) {
  try {
    await registerLimiter.consume(String(telegramId));
    return true;
  } catch {
    return false;
  }
}

/**
 * Telegraf middleware that applies global command rate limiting.
 */
function rateLimitMiddleware() {
  return async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return next();

    const allowed = await checkCommandLimit(userId);
    if (!allowed) {
      return ctx.reply('⚠️ You are sending commands too quickly. Please slow down.');
    }
    return next();
  };
}

module.exports = {
  checkTipLimit,
  checkCommandLimit,
  checkRegisterLimit,
  rateLimitMiddleware,
};
