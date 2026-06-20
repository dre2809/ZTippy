'use strict';

const db = require('./db');
const wallet = require('./wallet');
const config = require('./config');
const amount = require('./amount');
const logger = require('./logger');

/**
 * Resolves a tip target from either a @username mention or a reply context,
 * AND verifies the target is actually a member of the current group.
 *
 * This prevents tipping a username who happens to be registered with the bot
 * (from some other group) but has never been seen in this chat — important
 * once the bot is added to many independent communities.
 *
 * Returns the user record, or null if not found / not a member of this group.
 */
async function resolveTarget(ctx, mentionedUsername) {
  // Reply-based tipping: Telegram already guarantees reply_to_message.from
  // is a real member who posted in this chat, so no extra check needed.
  if (!mentionedUsername && ctx.message?.reply_to_message?.from) {
    const replyFrom = ctx.message.reply_to_message.from;
    return db.users.findById.get(String(replyFrom.id));
  }

  if (!mentionedUsername) return null;

  const clean = mentionedUsername.replace(/^@/, '').toLowerCase();
  const candidate = db.users.findByUsername.get(clean);
  if (!candidate) return null;

  // Private chats have no "membership" concept to verify against.
  if (ctx.chat.type === 'private') return candidate;

  // Group/supergroup: confirm the candidate is actually present in *this* chat.
  try {
    const member = await ctx.telegram.getChatMember(ctx.chat.id, Number(candidate.telegram_id));
    const validStatuses = ['creator', 'administrator', 'member', 'restricted'];
    if (!validStatuses.includes(member.status)) return null;
    return candidate;
  } catch (err) {
    // getChatMember throws if the user isn't a member of this chat at all —
    // this is the expected path for cross-group tip attempts.
    return null;
  }
}

/**
 * Validates a tip before execution.
 * Returns { valid: true } or { valid: false, reason: string }
 */
function validateTip({ sender, receiver, amountZats, groupId }) {
  if (!sender) return { valid: false, reason: 'You are not registered. Use /register first.' };
  if (!receiver) return { valid: false, reason: 'Recipient not found. They need to /register first.' };

  if (sender.telegram_id === receiver.telegram_id) {
    return { valid: false, reason: "You can't tip yourself!" };
  }

  const groupSettings = db.groups.get.get(groupId);
  const minTip = groupSettings?.min_tip_zats ?? config.tips.minZatoshis;

  if (amountZats < minTip) {
    return { valid: false, reason: `Minimum tip is ${wallet.formatZec(minTip)}.` };
  }

  if (BigInt(sender.balance_zats) < BigInt(amountZats)) {
    return { valid: false, reason: `Insufficient balance. Your balance: ${wallet.formatZec(sender.balance_zats)}.` };
  }

  return { valid: true };
}

/**
 * Entry point for /tip — validates the tip and, if it crosses the large-tip
 * threshold (config.tips.largeTipZecThreshold ZEC OR largeTipUsdThreshold
 * USD-equivalent, whichever is reached first), stores a pending confirmation
 * and asks the user to reply YES/NO instead of sending immediately.
 *
 * Small tips execute immediately, same as before — confirmation only adds
 * friction where it matters.
 */
async function initiateTip({ senderId, receiverId, amountZats, ctx }) {
  const groupId = String(ctx.chat.id);
  const sender = db.users.findById.get(senderId);
  const receiver = db.users.findById.get(receiverId);

  const validation = validateTip({ sender, receiver, amountZats, groupId });
  if (!validation.valid) return { success: false, reason: validation.reason };

  const { isLarge, usdValue } = await amount.checkLargeTip(BigInt(amountZats));

  if (!isLarge) {
    return executeTip({ senderId, receiverId, amountZats, ctx });
  }

  // Large tip — require explicit confirmation before sending.
  const now = Date.now();
  const expiresAt = now + config.security.withdrawalConfirmTimeoutSecs * 1000;

  db.confirmations.delete.run(senderId, 'tip');
  db.confirmations.insert.run({
    telegram_id: senderId,
    type: 'tip',
    payload_json: JSON.stringify({ receiverId, amountZats, groupId, groupTitle: ctx.chat.title || 'DM' }),
    expires_at: expiresAt,
    created_at: now,
  });

  const usdLine = usdValue !== null ? ` (~$${usdValue.toFixed(2)})` : '';
  const receiverName = receiver.username ? `@${receiver.username}` : receiver.first_name;

  return {
    success: true,
    requiresConfirmation: true,
    prompt: [
      `⚠️ *Large Tip — Please Confirm*\n`,
      `You're about to tip *${wallet.formatZec(amountZats)}*${usdLine}`,
      `To: ${receiverName}\n`,
      `Reply *YES* within ${config.security.withdrawalConfirmTimeoutSecs}s to confirm, or *NO* to cancel.`,
    ].join('\n'),
  };
}

/**
 * Confirms and executes a pending large tip (after /tip triggered the
 * large-tip confirmation flow and the user replied YES).
 */
async function confirmTip(senderId, ctx) {
  const pending = db.confirmations.get.get(senderId, 'tip', Date.now());
  if (!pending) {
    return { success: false, reason: 'No pending tip found, or it has expired. Please run /tip again.' };
  }

  db.confirmations.delete.run(senderId, 'tip');

  const { receiverId, amountZats } = JSON.parse(pending.payload_json);
  return executeTip({ senderId, receiverId, amountZats, ctx });
}

/**
 * Cancels a pending large-tip confirmation.
 */
function cancelTip(senderId) {
  db.confirmations.delete.run(senderId, 'tip');
}

/**
 * Executes a tip from sender to receiver.
 * All tips between registered users are off-chain SQLite updates for speed.
 */
async function executeTip({ senderId, receiverId, amountZats, ctx }) {
  const groupId = String(ctx.chat.id);
  const groupTitle = ctx.chat.title || 'DM';
  const sender = db.users.findById.get(senderId);
  const receiver = db.users.findById.get(receiverId);

  const validation = validateTip({ sender, receiver, amountZats, groupId });
  if (!validation.valid) return { success: false, reason: validation.reason };

  const memoJson = wallet.buildMemo({
    type: 'tip',
    fromHandle: sender.username || sender.first_name,
    toHandle: receiver.username || receiver.first_name,
    groupName: groupTitle,
    communityUuid: groupId, // every Telegram group is its own community scope
  });

  const tipData = {
    from_id: senderId,
    to_id: receiverId,
    amount_zats: amountZats,
    memo_json: memoJson,
    group_id: groupId,
    group_title: groupTitle,
    created_at: Date.now(),
  };

  try {
    db.executeTip(senderId, receiverId, amountZats, tipData);
    logger.info(`Tip: ${senderId} → ${receiverId} | ${wallet.formatZec(amountZats)} | group: ${groupId}`);

    return {
      success: true,
      sender,
      receiver,
      amountZats,
      formattedAmount: wallet.formatZec(amountZats),
    };
  } catch (err) {
    if (err.message === 'INSUFFICIENT_BALANCE') {
      return { success: false, reason: `Insufficient balance. Your balance: ${wallet.formatZec(sender.balance_zats)}.` };
    }
    logger.error('Tip execution failed:', err);
    return { success: false, reason: 'An error occurred processing your tip. Please try again.' };
  }
}

/**
 * Executes a /rain split tip among recent active users.
 * Each recipient gets (totalAmount / n) zatoshis.
 */
async function executeRain({ senderId, totalAmountZats, numRecipients, ctx }) {
  const groupId = String(ctx.chat.id);
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

  const sender = db.users.findById.get(senderId);
  if (!sender) return { success: false, reason: 'You are not registered. Use /register first.' };

  if (numRecipients < 1 || numRecipients > config.tips.rainMaxUsers) {
    return { valid: false, reason: `Rain recipients must be between 1 and ${config.tips.rainMaxUsers}.` };
  }

  // Get recent active users in group (excluding sender)
  const recentUsers = db.users.getRecentActiveInGroup.all(groupId, thirtyDaysAgo, numRecipients + 5)
    .filter(u => u.telegram_id !== senderId)
    .slice(0, numRecipients);

  if (recentUsers.length === 0) {
    return { success: false, reason: 'No recent active users found in this group to rain on.' };
  }

  const actualN = recentUsers.length;
  const perUserZats = Math.floor(totalAmountZats / actualN);

  if (perUserZats < config.tips.minZatoshis) {
    return { success: false, reason: `Each rain share (${wallet.formatZec(perUserZats)}) is below the minimum tip amount.` };
  }

  const totalNeeded = perUserZats * actualN;

  if (BigInt(sender.balance_zats) < BigInt(totalNeeded)) {
    return { success: false, reason: `Insufficient balance. Need ${wallet.formatZec(totalNeeded)}, have ${wallet.formatZec(sender.balance_zats)}.` };
  }

  // Execute all tips in a single DB transaction
  const groupTitle = ctx.chat.title || 'Group';
  const now = Date.now();
  const tippedUsers = [];

  const rainTransaction = db.db.transaction(() => {
    for (const recipient of recentUsers) {
      const memoJson = wallet.buildMemo({
        type: 'rain',
        fromHandle: sender.username || sender.first_name,
        toHandle: recipient.username || recipient.first_name,
        groupName: groupTitle,
        communityUuid: groupId,
      });

      db.executeTip(senderId, recipient.telegram_id, perUserZats, {
        from_id: senderId,
        to_id: recipient.telegram_id,
        amount_zats: perUserZats,
        memo_json: memoJson,
        group_id: groupId,
        group_title: groupTitle,
        created_at: now,
      });

      tippedUsers.push(recipient);
    }
  });

  try {
    rainTransaction();
    logger.info(`Rain: ${senderId} → ${actualN} users | ${wallet.formatZec(perUserZats)} each | group: ${groupId}`);
    return { success: true, tippedUsers, perUserZats, totalZats: totalNeeded };
  } catch (err) {
    logger.error('Rain execution failed:', err);
    return { success: false, reason: 'Rain failed. Please try again.' };
  }
}

/**
 * Returns formatted tip history for a user.
 */
function getTipHistory(telegramId) {
  const tips = db.tips.getHistory.all(telegramId, telegramId);
  return tips.map(t => ({
    ...t,
    isSent: t.from_id === telegramId,
    formattedAmount: wallet.formatZec(t.amount_zats),
    date: new Date(t.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
  }));
}

/**
 * Returns formatted personal stats for a user.
 */
function getUserStats(telegramId) {
  const stats = db.tips.getStats.get(telegramId, telegramId, telegramId, telegramId, telegramId);
  return {
    totalSent: wallet.formatZec(stats.total_sent),
    totalReceived: wallet.formatZec(stats.total_received),
    sentCount: stats.sent_count,
    receivedCount: stats.received_count,
    largestReceived: wallet.formatZec(stats.largest_received),
  };
}

module.exports = {
  resolveTarget,
  validateTip,
  initiateTip,
  confirmTip,
  cancelTip,
  executeTip,
  executeRain,
  getTipHistory,
  getUserStats,
};
