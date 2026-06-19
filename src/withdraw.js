'use strict';

const db = require('./db');
const wallet = require('./wallet');
const config = require('./config');
const logger = require('./logger');

/**
 * Checks if a user is past the withdrawal cooldown period.
 */
function isWithinCooldown(user) {
  const cooldownMs = config.security.withdrawalCooldownSecs * 1000;
  return (Date.now() - user.registered_at) < cooldownMs;
}

/**
 * Initiates a withdrawal — validates, stores a pending confirmation,
 * and returns the confirmation prompt text.
 */
async function initiateWithdrawal({ telegramId, toAddress, amountInput }) {
  const user = db.users.findById.get(telegramId);
  if (!user) return { success: false, reason: 'You are not registered. Use /register first.' };

  if (isWithinCooldown(user)) {
    const remaining = Math.ceil(
      (config.security.withdrawalCooldownSecs - (Date.now() - user.registered_at) / 1000) / 60
    );
    return { success: false, reason: `Withdrawals are locked for ${remaining} more minute(s) after registration.` };
  }

  // Validate address
  const addrCheck = wallet.rejectNonUA(toAddress);
  if (!addrCheck.valid) return { success: false, reason: addrCheck.reason };

  // Parse amount
  let amountZats;
  try {
    amountZats = Number(wallet.zecToZats(amountInput));
    if (!Number.isFinite(amountZats) || amountZats <= 0) throw new Error('invalid');
  } catch {
    return { success: false, reason: 'Invalid amount. Use a number like 0.01 (in ZEC).' };
  }

  // Calculate ZIP-317 fee
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

  // Store pending confirmation
  const now = Date.now();
  const expiresAt = now + config.security.withdrawalConfirmTimeoutSecs * 1000;

  // Clear any existing pending confirmation
  db.confirmations.delete.run(telegramId, 'withdrawal');

  db.confirmations.insert.run({
    telegram_id: telegramId,
    type: 'withdrawal',
    payload_json: JSON.stringify({ toAddress, amountZats, feeZats }),
    expires_at: expiresAt,
    created_at: now,
  });

  return {
    success: true,
    requiresConfirmation: true,
    prompt: [
      `⚠️ *Confirm Withdrawal*\n`,
      `Amount: *${wallet.formatZec(amountZats)}*`,
      `Fee: ${wallet.formatZec(feeZats)} (ZIP-317)`,
      `Total deducted: *${wallet.formatZec(totalNeeded)}*`,
      `To: \`${toAddress.slice(0, 20)}...${toAddress.slice(-6)}\`\n`,
      `Reply *YES* within ${config.security.withdrawalConfirmTimeoutSecs}s to confirm, or *NO* to cancel.`,
    ].join('\n'),
  };
}

/**
 * Confirms and executes a pending withdrawal.
 */
async function confirmWithdrawal(telegramId) {
  const pending = db.confirmations.get.get(telegramId, 'withdrawal', Date.now());
  if (!pending) {
    return { success: false, reason: 'No pending withdrawal found, or it has expired. Please run /withdraw again.' };
  }

  const { toAddress, amountZats, feeZats } = JSON.parse(pending.payload_json);
  const user = db.users.findById.get(telegramId);

  // Re-validate balance (may have changed)
  const totalNeeded = amountZats + feeZats;
  if (BigInt(user.balance_zats) < BigInt(totalNeeded)) {
    db.confirmations.delete.run(telegramId, 'withdrawal');
    return { success: false, reason: 'Insufficient balance. Your balance may have changed.' };
  }

  const memo = wallet.buildMemo({
    type: 'withdrawal',
    fromHandle: user.username || user.first_name,
    groupName: config.community.name,
    communityUuid: 'withdrawal', // withdrawals aren't scoped to a single group
  });

  // Debit user balance and create withdrawal record atomically
  let withdrawalId;
  try {
    withdrawalId = db.executeWithdrawalDebit(telegramId, amountZats, feeZats, {
      telegram_id: telegramId,
      to_address: toAddress,
      amount_zats: amountZats,
      fee_zats: feeZats,
      created_at: Date.now(),
    });
  } catch (err) {
    if (err.message === 'INSUFFICIENT_BALANCE') {
      return { success: false, reason: 'Insufficient balance.' };
    }
    logger.error('Withdrawal debit failed:', err);
    return { success: false, reason: 'Failed to process withdrawal. Please try again.' };
  }

  // Clear confirmation
  db.confirmations.delete.run(telegramId, 'withdrawal');

  // Broadcast to network
  try {
    const { txid } = await wallet.broadcastWithdrawal({
      toAddress,
      amountZats: BigInt(amountZats),
      feeZats: BigInt(feeZats),
      memo,
    });

    db.withdrawals.updateStatus.run('broadcast', txid, null, null, withdrawalId);
    logger.info(`Withdrawal broadcast: ${telegramId} → ${toAddress} | ${wallet.formatZec(amountZats)} | txid: ${txid}`);

    return {
      success: true,
      txid,
      amountZats,
      feeZats,
      toAddress,
      formattedAmount: wallet.formatZec(amountZats),
    };
  } catch (err) {
    // Refund balance on broadcast failure
    logger.error('Broadcast failed, refunding:', err);
    db.db.prepare('UPDATE users SET balance_zats = balance_zats + ? WHERE telegram_id = ?').run(totalNeeded, telegramId);
    db.withdrawals.updateStatus.run('failed', null, err.message, null, withdrawalId);
    return { success: false, reason: 'Transaction broadcast failed. Your balance has been refunded.' };
  }
}

/**
 * Cancels a pending withdrawal confirmation.
 */
function cancelWithdrawal(telegramId) {
  db.confirmations.delete.run(telegramId, 'withdrawal');
}

module.exports = {
  initiateWithdrawal,
  confirmWithdrawal,
  cancelWithdrawal,
};
