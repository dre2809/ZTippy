'use strict';

/**
 * intents.js — NEAR Intents 1Click API integration
 *
 * Handles cross-chain withdrawals from ZEC to BTC, ETH, BNB, USDC, USDT
 * via the 1Click API at https://1click.chaindefuser.com
 */

const https = require('https');
const logger = require('./logger');

const ONE_CLICK_BASE = 'https://1click.chaindefuser.com';
const ZEC_ASSET_ID = 'nep141:zec.omft.near';

// Supported destination tokens and their asset IDs
const SUPPORTED_TOKENS = {
  btc: {
    BTC: { assetId: 'nep141:btc.omft.near', decimals: 8, label: 'Bitcoin (BTC)' },
  },
  eth: {
    ETH:  { assetId: 'nep141:eth.omft.near', decimals: 18, label: 'Ethereum (ETH)' },
    USDC: { assetId: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near', decimals: 6, label: 'USDC (Ethereum)' },
    USDT: { assetId: 'nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near', decimals: 6, label: 'USDT (Ethereum)' },
  },
  arb: {
    ETH:  { assetId: 'nep141:arb.omft.near', decimals: 18, label: 'ETH (Arbitrum)' },
    USDC: { assetId: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near', decimals: 6, label: 'USDC (Arbitrum)' },
  },
  base: {
    ETH:  { assetId: 'nep141:base.omft.near', decimals: 18, label: 'ETH (Base)' },
    USDC: { assetId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near', decimals: 6, label: 'USDC (Base)' },
  },
  bsc: {
    BNB:  { assetId: 'nep245:v2_1.omni.hot.tg:56_11111111111111111111', decimals: 18, label: 'BNB (BSC)' },
    USDC: { assetId: 'nep245:v2_1.omni.hot.tg:56_2w93GqMcEmQFDru84j3HZZWt557r', decimals: 18, label: 'USDC (BSC)' },
    USDT: { assetId: 'nep245:v2_1.omni.hot.tg:56_2CMMyVTGZkeyNZTSvS5sarzfir6g', decimals: 18, label: 'USDT (BSC)' },
  },
};

const CHAIN_LABELS = {
  btc:  '₿ Bitcoin',
  eth:  '⟠ Ethereum',
  arb:  '🔵 Arbitrum',
  base: '🔵 Base',
  bsc:  '🟡 BNB Chain',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function httpsRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const jwt = process.env.NEAR_INTENTS_JWT;
    const headers = { 'Content-Type': 'application/json', 'User-Agent': 'ztippy/1.0' };
    if (jwt) headers['Authorization'] = `Bearer ${jwt}`;

    const url = new URL(ONE_CLICK_BASE + path);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`HTTP ${res.statusCode}: ${JSON.stringify(parsed)}`));
          }
          resolve(parsed);
        } catch (e) {
          reject(new Error(`Invalid JSON: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('Request timed out')));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Get a swap quote from ZEC to a destination token.
 * amountZats — amount in zatoshis to swap
 * chain      — destination chain key (btc, eth, arb, base, bsc)
 * token      — destination token symbol (BTC, ETH, USDC, USDT, BNB)
 * recipient  — destination address on the target chain
 * refundAddress — ZEC address to refund to if swap fails (user's u1 address)
 */
async function getSwapQuote({ amountZats, chain, token, recipient, refundAddress }) {
  const tokenInfo = SUPPORTED_TOKENS[chain]?.[token];
  if (!tokenInfo) throw new Error(`Unsupported token: ${token} on ${chain}`);

  // ZEC has 8 decimals, zatoshis = smallest unit
  const amountIn = String(amountZats);

  const deadline = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 min

  const body = {
    dry: false,
    swapType: 'EXACT_INPUT',
    slippageTolerance: 100, // 1%
    originAsset: ZEC_ASSET_ID,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: tokenInfo.assetId,
    amount: amountIn,
    recipient,
    recipientType: 'DESTINATION_CHAIN',
    refundTo: refundAddress,
    refundType: 'ORIGIN_CHAIN',
    deadline,
  };

  logger.debug('1Click quote request:', JSON.stringify(body));
  const quote = await httpsRequest('POST', '/v0/quote', body);
  logger.debug('1Click quote response:', JSON.stringify(quote));

  return {
    depositAddress: quote.depositAddress,
    depositMemo: quote.depositMemo || null,
    amountIn: quote.amountIn,
    amountOut: quote.amountOut,
    amountOutFormatted: quote.amountOutFormatted,
    minAmountOut: quote.minAmountOut,
    deadline: quote.deadline,
    timeEstimate: quote.timeEstimate, // seconds
    tokenInfo,
    chain,
    token,
    recipient,
  };
}

/**
 * Check the status of a swap by deposit address.
 */
async function getSwapStatus(depositAddress) {
  const data = await httpsRequest('GET', `/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`);
  return data;
}

/**
 * Format a quote for display in Telegram.
 */
function formatQuote(quote, amountZats) {
  const zecAmount = (amountZats / 1e8).toFixed(8).replace(/\.?0+$/, '');
  const timeMin = Math.ceil(quote.timeEstimate / 60);
  const lines = [
    `🔄 *Swap Quote*\n`,
    `From: *${zecAmount} ZEC*`,
    `To: *${quote.amountOutFormatted} ${quote.token}* (${CHAIN_LABELS[quote.chain]})`,
    `Est. time: ~${timeMin} min`,
    `\n📬 *Send ZEC to:*`,
    `\`${quote.depositAddress}\``,
  ];
  if (quote.depositMemo) lines.push(`Memo: \`${quote.depositMemo}\``);
  lines.push(`\n⚠️ Send *exactly* ${zecAmount} ZEC. Funds auto-refund if swap fails.`);
  return lines.join('\n');
}

module.exports = {
  SUPPORTED_TOKENS,
  CHAIN_LABELS,
  getSwapQuote,
  getSwapStatus,
  formatQuote,
};
