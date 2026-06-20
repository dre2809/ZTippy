'use strict';

/**
 * price.js — ZEC/USD price lookup with caching.
 *
 * Used to:
 *   1. Parse USD-denominated amounts ("$5", "5 usd") into zatoshis
 *   2. Determine whether a ZEC amount crosses the large-tip USD threshold
 *
 * CoinGecko's public endpoint requires no API key for simple price lookups,
 * but is rate-limited — responses are cached for `config.price.cacheTtlSecs`
 * (default 2 minutes) so a burst of tips doesn't hammer the API or risk
 * getting temporarily blocked.
 */

const https = require('https');
const config = require('./config');
const logger = require('./logger');
const wallet = require('./wallet');

let _cache = { priceUsd: null, fetchedAt: 0 };

/**
 * Performs a simple HTTPS GET and parses the JSON response.
 * Uses Node's built-in https module — no extra dependency needed for one endpoint.
 */
function httpsGetJson(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'zcash-tipbot/1.0' } }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(new Error(`Invalid JSON response: ${err.message}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('Request timed out'));
    });
  });
}

/**
 * Returns the current ZEC/USD price, using the cache if still fresh.
 * Throws if the price can't be fetched and there's no usable cached value.
 *
 * @returns {Promise<number>} price of 1 ZEC in USD
 */
async function getZecUsdPrice() {
  const ageSecs = (Date.now() - _cache.fetchedAt) / 1000;
  if (_cache.priceUsd !== null && ageSecs < config.price.cacheTtlSecs) {
    return _cache.priceUsd;
  }

  try {
    const url = `${config.price.coingeckoUrl}/simple/price?ids=zcash&vs_currencies=usd`;
    const data = await httpsGetJson(url);
    const price = data?.zcash?.usd;

    if (typeof price !== 'number' || price <= 0) {
      throw new Error('Unexpected response shape from CoinGecko');
    }

    _cache = { priceUsd: price, fetchedAt: Date.now() };
    return price;
  } catch (err) {
    logger.warn(`ZEC/USD price fetch failed: ${err.message}`);

    // Fall back to a stale cached price rather than failing outright —
    // a slightly-stale price is far better than blocking all tips/withdrawals
    // every time CoinGecko has a hiccup.
    if (_cache.priceUsd !== null) {
      logger.warn(`Using stale cached price: $${_cache.priceUsd} (age: ${Math.round(ageSecs)}s)`);
      return _cache.priceUsd;
    }

    throw new Error('ZEC price unavailable and no cached price to fall back on.');
  }
}

/**
 * Converts a USD amount to zatoshis using the current ZEC/USD price.
 * @param {number} usdAmount
 * @returns {Promise<bigint>} amount in zatoshis
 */
async function usdToZats(usdAmount) {
  const price = await getZecUsdPrice();
  const zec = usdAmount / price;
  return wallet.zecToZats(zec.toFixed(8));
}

/**
 * Converts a zatoshi amount to its current USD value.
 * @param {bigint|number} zats
 * @returns {Promise<number>} USD value
 */
async function zatsToUsd(zats) {
  const price = await getZecUsdPrice();
  const zec = Number(wallet.zatsToZec(zats));
  return zec * price;
}

module.exports = {
  getZecUsdPrice,
  usdToZats,
  zatsToUsd,
};
