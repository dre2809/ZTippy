'use strict';

const db = require('./db');
const wallet = require('./wallet');
const config = require('./config');
const amount = require('./amount');
const logger = require('./logger');

async function resolveTarget(ctx, mentionedUsername) {
  if (!mentionedUsername && ctx.message?.reply_to_message?.from) {
    const replyFrom = ctx.message.reply_to_message.from;
    return db.users.findById(String(replyFrom.id));
  }
  if (!mentionedUsername) return null;

  const clean = mentionedUsername.replace(/^@/, '').toLowerCase();
  const candidate = await db.users.findByUsername(clean);
  if (!candidate) return null;

  if (ctx.chat.type === 'private') return candidate;

  try {
    const member = await ctx.telegram.getChatMember(ctx.chat.id, Number(candidate.telegram_id));
    const validStatuses = ['creator', 'administrator', 'member', 'restricted'];
    if (!validStatuses.includes(member.status)) return null;
    return candidate;
  } catch (err) {
    return null;
  }
}

async function validateTip({ sender, receiver, amountZats, groupId }) {
  if (!sender) return { valid: false, reason: 'You are not registered. Use /register first.' };
  if (!receiver) return { valid: false, reason: 'Recipient not found. They need to /register first.' };
  if (sender.telegram_id === receiver.telegram_id) return { valid: false, reason: "You can't tip yourself!" };

  const groupSettings = await db.groups.get(groupId);
  const minTip = groupSettings?.min_tip_zats ?? config.tips.minZatoshis;

  if (amountZats < minTip) return { valid: false, reason: `Minimum tip is ${wallet.formatZec(minTip)}.` };
  if (BigInt(sender.balance_zats) < BigInt(amountZats)) {
    return { valid: false, reason: `Insufficient balance. Your balance: ${wallet.formatZec(sender.balance_zats)}.` };
  }
  return { valid: true };
}

async function initiateTip({ senderId, receiverId, receiverUsername, amountZats, ctx }) {
  const groupId = String(ctx.chat.id);
  const sender = await db.users.findById(senderId);
  if (!sender) return { success: false, reason: 'You are not registered. Use /register first.' };

  const groupSettings = await db.groups.get(groupId);
  const minTip = groupSettings?.min_tip_zats ?? config.tips.minZatoshis;
  if (amountZats < minTip) return { success: false, reason: `Minimum tip is ${wallet.formatZec(minTip)}.` };
  if (BigInt(sender.balance_zats) < BigInt(amountZats)) {
    return { success: false, reason: `Insufficient balance. Your balance: ${wallet.formatZec(sender.balance_zats)}.` };
  }

  const receiver = await db.users.findById(receiverId);

  // If receiver is not registered, store as pending balance
  if (!receiver) {
    const username = receiverUsername?.replace(/^@/, '').toLowerCase();
    if (!username) return { success: false, reason: 'Recipient not found. They need to /register first.' };

    // Debit sender
    const debit = await db.execute(
      'UPDATE users SET balance_zats = balance_zats - ? WHERE telegram_id = ? AND balance_zats >= ?',
      [amountZats, senderId, amountZats]
    );
    if (debit.changes === 0) return { success: false, reason: `Insufficient balance. Your balance: ${wallet.formatZec(sender.balance_zats)}.` };

    // Store pending balance
    await db.execute(
      'INSERT INTO pending_balances (to_username, from_id, amount_zats, group_id, group_title, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [username, senderId, amountZats, groupId, ctx.chat.title || 'Group', Date.now()]
    );
    await db.syncToTurso();

    return {
      success: true,
      pending: true,
      username,
      formattedAmount: wallet.formatZec(amountZats),
    };
  }

  const { isLarge, usdValue } = await amount.checkLargeTip(BigInt(amountZats));
  if (!isLarge) return executeTip({ senderId, receiverId, amountZats, ctx });

  const now = Date.now();
  const expiresAt = now + config.security.withdrawalConfirmTimeoutSecs * 1000;

  await db.confirmations.delete(senderId, 'tip');
  await db.confirmations.insert({
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

async function confirmTip(senderId, ctx) {
  const pending = await db.confirmations.get(senderId, 'tip', Date.now());
  if (!pending) return { success: false, reason: 'No pending tip found, or it has expired. Please run /tip again.' };

  await db.confirmations.delete(senderId, 'tip');
  const { receiverId, amountZats } = JSON.parse(pending.payload_json);
  return executeTip({ senderId, receiverId, amountZats, ctx });
}

function cancelTip(senderId) {
  return db.confirmations.delete(senderId, 'tip');
}

async function executeTip({ senderId, receiverId, amountZats, ctx }) {
  const groupId = String(ctx.chat.id);
  const groupTitle = ctx.chat.title || 'DM';
  const sender = await db.users.findById(senderId);
  const receiver = await db.users.findById(receiverId);

  const validation = await validateTip({ sender, receiver, amountZats, groupId });
  if (!validation.valid) return { success: false, reason: validation.reason };

  const memoJson = wallet.buildMemo({
    type: 'tip',
    fromHandle: sender.username || sender.first_name,
    toHandle: receiver.username || receiver.first_name,
    groupName: groupTitle,
    communityUuid: groupId,
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
    await db.executeTip(senderId, receiverId, amountZats, tipData);
    logger.info(`Tip: ${senderId} → ${receiverId} | ${wallet.formatZec(amountZats)} | group: ${groupId}`);
    const updatedSender = await db.users.findById(senderId);
    const updatedReceiver = await db.users.findById(receiverId);
    return {
      success: true,
      sender: updatedSender,
      receiver: updatedReceiver,
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

async function executeRain({ senderId, totalAmountZats, numRecipients, ctx }) {
  const groupId = String(ctx.chat.id);
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

  const sender = await db.users.findById(senderId);
  if (!sender) return { success: false, reason: 'You are not registered. Use /register first.' };
  if (numRecipients < 1 || numRecipients > config.tips.rainMaxUsers) {
    return { success: false, reason: `Rain recipients must be between 1 and ${config.tips.rainMaxUsers}.` };
  }

  const recentUsers = (await db.users.getRecentActiveInGroup(groupId, thirtyDaysAgo, numRecipients + 5))
    .filter(u => u.telegram_id !== senderId)
    .slice(0, numRecipients);

  if (recentUsers.length === 0) return { success: false, reason: 'No recent active users found in this group.' };

  const actualN = recentUsers.length;
  const perUserZats = Math.floor(totalAmountZats / actualN);

  if (perUserZats < config.tips.minZatoshis) {
    return { success: false, reason: `Each rain share (${wallet.formatZec(perUserZats)}) is below the minimum tip amount.` };
  }

  const totalNeeded = perUserZats * actualN;
  if (BigInt(sender.balance_zats) < BigInt(totalNeeded)) {
    return { success: false, reason: `Insufficient balance. Need ${wallet.formatZec(totalNeeded)}, have ${wallet.formatZec(sender.balance_zats)}.` };
  }

  const groupTitle = ctx.chat.title || 'Group';
  const now = Date.now();
  const tippedUsers = [];

  try {
    for (const recipient of recentUsers) {
      const memoJson = wallet.buildMemo({
        type: 'rain',
        fromHandle: sender.username || sender.first_name,
        toHandle: recipient.username || recipient.first_name,
        groupName: groupTitle,
        communityUuid: groupId,
      });
      await db.executeTip(senderId, recipient.telegram_id, perUserZats, {
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
    logger.info(`Rain: ${senderId} → ${actualN} users | ${wallet.formatZec(perUserZats)} each | group: ${groupId}`);
    return { success: true, tippedUsers, perUserZats, totalZats: totalNeeded };
  } catch (err) {
    logger.error('Rain execution failed:', err);
    return { success: false, reason: 'Rain failed. Please try again.' };
  }
}

async function getTipHistory(telegramId) {
  const tipList = await db.tips.getHistory(telegramId);
  return tipList.map(t => ({
    ...t,
    isSent: t.from_id === telegramId,
    formattedAmount: wallet.formatZec(t.amount_zats),
    date: new Date(t.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
  }));
}

async function getUserStats(telegramId) {
  const stats = await db.tips.getStats(telegramId);
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
