'use strict';

const db = require('./db');
const wallet = require('./wallet');
const config = require('./config');
const amount = require('./amount');
const logger = require('./logger');

function isWithinCooldown(user) {
  const cooldownMs = config.security.withdrawalCooldownSecs * 1000;
  return (Date.now() - user.registered_at) < cooldownMs;
}

async function initiateWithdrawal({ telegramId, toAddress, amountInput }) {
  const user = await db.users.findById(telegramId);
  if (!user) return { success: false, reason: 'You are not registered. Use /register first.' };

  if (isWithinCooldown(user)) {
    const remaining = Math.ceil(
      (config.security.withdrawalCooldownSecs - (Date.now() - user.registered_at) / 1000) / 60
    );
    return { success: false, reason: `Withdrawals are locked for ${remaining} more minute(s) after registration.` };
  }

  const addrCheck = wallet.rejectNonUA(toAddress);
  if (!addrCheck.valid) return { success: false, reason: addrCheck.reason };

  let parsed;
  try {
    parsed = await amount.parseAmount(amountInput);
  } catch (err) {
    if (err.message === 'PRICE_UNAVAILABLE') {
      return { success: false, reason: 'Could not fetch ZEC price. Please try again or use a ZEC amount.' };
    }
    throw err;
  }

  if (!parsed) return { success: false, reason: 'Invalid amount. Use a ZEC amount like 0.01, or a USD amount like $5.' };

  const amountZats = Number(parsed.amountZats);
  const usdNote = parsed.currency === 'USD' ? ` (~$${parsed.rawUsd.toFixed(2)})` : '';
  const feeZats = Number(wallet.calculateFee(2));
  const totalNeeded = amountZats + feeZats;

  if (BigInt(user.balance_zats) < BigInt(totalNeeded)) {
    return {
      success: false,
      reason: `Insufficient balance.\nRequested: ${wallet.formatZec(amountZats)}\nFee (ZIP-317): ${wallet.formatZec(feeZats)}\nTotal needed: ${wallet.formatZec(totalNeeded)}\nYour balance: ${wallet.formatZec(user.balance_zats)}`,
    };
  }

  if (amountZats < config.tips.minZatoshis) {
    return { success: false, reason: `Minimum withdrawal is ${wallet.formatZec(config.tips.minZatoshis)}.` };
  }

  const now = Date.now();
  const expiresAt = now + config.security.withdrawalConfirmTimeoutSecs * 1000;

  await db.confirmations.delete(telegramId, 'withdrawal');
  await db.confirmations.insert({
    telegram_id: telegramId,
    type: 'withdrawal',
    payload_json: JSON.stringify({ toAddress, amountZats, feeZats }),
    expires_at: expiresAt,
    created_at: now,
  });

  const { isLarge, usdValue } = await amount.checkLargeTip(BigInt(amountZats));
  const usdLine = usdNote || (usdValue !== null ? ` (~$${usdValue.toFixed(2)})` : '');
  const largeNote = isLarge
    ? `\n⚠️ _This is a large withdrawal — double-check the address before confirming._\n`
    : '';

  return {
    success: true,
    requiresConfirmation: true,
    prompt: [
      `⚠️ *Confirm Withdrawal*\n`,
      `Amount: *${wallet.formatZec(amountZats)}*${usdLine}`,
      `Fee: ${wallet.formatZec(feeZats)} (ZIP-317)`,
      `Total deducted: *${wallet.formatZec(totalNeeded)}*`,
      `To: \`${toAddress.slice(0, 20)}...${toAddress.slice(-6)}\`${largeNote}`,
      `Reply *YES* within ${config.security.withdrawalConfirmTimeoutSecs}s to confirm, or *NO* to cancel.`,
    ].join('\n'),
  };
}

async function confirmWithdrawal(telegramId) {
  const pending = await db.confirmations.get(telegramId, 'withdrawal', Date.now());
  if (!pending) return { success: false, reason: 'No pending withdrawal found, or it has expired. Please run /withdraw again.' };

  const { toAddress, amountZats, feeZats } = JSON.parse(pending.payload_json);
  const user = await db.users.findById(telegramId);

  const totalNeeded = amountZats + feeZats;
  if (BigInt(user.balance_zats) < BigInt(totalNeeded)) {
    await db.confirmations.delete(telegramId, 'withdrawal');
    return { success: false, reason: 'Insufficient balance. Your balance may have changed.' };
  }

  const memo = wallet.buildMemo({
    type: 'withdrawal',
    fromHandle: user.username || user.first_name,
    groupName: config.community.name,
    communityUuid: 'withdrawal',
  });

  let withdrawalId;
  try {
    withdrawalId = await db.executeWithdrawalDebit(telegramId, amountZats, feeZats, {
      telegram_id: telegramId,
      to_address: toAddress,
      amount_zats: amountZats,
      fee_zats: feeZats,
      created_at: Date.now(),
    });
  } catch (err) {
    if (err.message === 'INSUFFICIENT_BALANCE') return { success: false, reason: 'Insufficient balance.' };
    logger.error('Withdrawal debit failed:', err);
    return { success: false, reason: 'Failed to process withdrawal. Please try again.' };
  }

  await db.confirmations.delete(telegramId, 'withdrawal');

  try {
    const { txid } = await wallet.broadcastWithdrawal({
      toAddress,
      amountZats: BigInt(amountZats),
      feeZats: BigInt(feeZats),
      memo,
    });

    await db.withdrawals.updateStatus('broadcast', txid, null, null, withdrawalId);
    logger.info(`Withdrawal broadcast: ${telegramId} → ${toAddress} | ${wallet.formatZec(amountZats)} | txid: ${txid}`);

    return { success: true, txid, amountZats, feeZats, toAddress, formattedAmount: wallet.formatZec(amountZats) };
  } catch (err) {
    logger.error('Broadcast failed, refunding:', err);
    await db.execute(
      'UPDATE users SET balance_zats = balance_zats + ? WHERE telegram_id = ?',
      [totalNeeded, telegramId]
    );
    await db.withdrawals.updateStatus('failed', null, err.message, null, withdrawalId);
    return { success: false, reason: 'Transaction broadcast failed. Your balance has been refunded.' };
  }
}

function cancelWithdrawal(telegramId) {
  return db.confirmations.delete(telegramId, 'withdrawal');
}

module.exports = { initiateWithdrawal, confirmWithdrawal, cancelWithdrawal };
