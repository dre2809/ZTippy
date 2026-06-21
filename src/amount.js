'use strict';

/**
 * amount.js — parses user-supplied amount strings in either ZEC or USD,
 * and determines whether an amount counts as a "large tip" requiring
 * confirmation.
 *
 * Accepted formats:
 *   ZEC:  "0.001"      "0.001zec"      "0.001 ZEC"
 *   USD:  "$5"          "5usd"          "5 USD"        "$5.50"
 *
 * If no currency marker is present, the amount is treated as ZEC —
 * this matches how the bot has always worked, so existing muscle memory
 * ("/tip @user 0.01") keeps working unchanged.
 */

const wallet = require('./wallet');
const price = require('./price');
const config = require('./config');

/**
 * Parses a raw amount string into zatoshis, detecting ZEC vs USD format.
 *
 * @param {string} input - raw amount string from the user's message
 * @returns {Promise<{ amountZats: bigint, currency: 'ZEC'|'USD', rawUsd: number|null } | null>}
 *          null if the input couldn't be parsed at all
 */
async function parseAmount(input) {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();

  // ── USD format: "$5", "$5.50", "5usd", "5 usd", "5USD" ──────────────────
  const usdMatch = trimmed.match(/^\$?\s*([0-9]+(?:\.[0-9]+)?)\s*(usd)?$/i);
  const hasUsdMarker = trimmed.startsWith('$') || /usd\s*$/i.test(trimmed);

  if (hasUsdMarker && usdMatch) {
    const usdAmount = parseFloat(usdMatch[1]);
    if (!Number.isFinite(usdAmount) || usdAmount <= 0) return null;

    try {
      const amountZats = await price.usdToZats(usdAmount);
      if (amountZats <= 0n) return null;
      return { amountZats, currency: 'USD', rawUsd: usdAmount };
    } catch (err) {
      // Price lookup failed (CoinGecko down, no cache) — signal this
      // distinctly so the caller can give a specific error message.
      const e = new Error('PRICE_UNAVAILABLE');
      e.cause = err;
      throw e;
    }
  }

  // ── ZEC format: "0.001", "0.001zec", "0.001 ZEC" ─────────────────────────
  const zecMatch = trimmed.match(/^([0-9]+(?:\.[0-9]+)?)\s*(zec)?$/i);
  if (zecMatch) {
    try {
      const amountZats = wallet.zecToZats(zecMatch[1]);
      if (amountZats <= 0n) return null;
      return { amountZats, currency: 'ZEC', rawUsd: null };
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Determines whether an amount counts as a "large tip" requiring explicit
 * confirmation — triggered by crossing EITHER the fixed ZEC threshold OR
 * the USD-equivalent threshold (live price), whichever comes first.
 *
 * @param {bigint} amountZats
 * @returns {Promise<{ isLarge: boolean, usdValue: number|null }>}
 */
async function checkLargeTip(amountZats) {
  const zecThresholdZats = wallet.zecToZats(String(config.tips.largeTipZecThreshold));

  if (amountZats >= zecThresholdZats) {
    // Already over the ZEC threshold — no need to even check USD price.
    let usdValue = null;
    try {
      usdValue = await price.zatsToUsd(amountZats);
    } catch {
      // Price unavailable — the ZEC threshold alone is enough to flag it.
    }
    return { isLarge: true, usdValue };
  }

  // Under the ZEC threshold — check the USD-equivalent threshold too,
  // since at high ZEC prices a small ZEC amount could still be a lot of money.
  try {
    const usdValue = await price.zatsToUsd(amountZats);
    return { isLarge: usdValue >= config.tips.largeTipUsdThreshold, usdValue };
  } catch {
    // Price unavailable and under the ZEC threshold — don't block the tip
    // over a price-feed outage; just don't flag it as large.
    return { isLarge: false, usdValue: null };
  }
}

module.exports = {
  parseAmount,
  checkLargeTip,
};
