'use strict';

const wallet = require('./wallet');
const config = require('./config');

/**
 * Formats a display name: @username or First Name
 */
function displayName(user) {
  if (user.username) return `@${user.username}`;
  return user.first_name || 'Unknown';
}

/**
 * Truncates a UA address for display: u1abcd...xyz
 */
function shortAddress(addr) {
  if (!addr || addr.length < 20) return addr;
  return `${addr.slice(0, 10)}...${addr.slice(-6)}`;
}

const LOGO = '🛡️';
const ZEC_LOGO = '⚡';

function welcome(user, uaAddress) {
  return [
    `${LOGO} *Welcome to ${config.community.name}!*`,
    ``,
    `You're registered and ready to tip ZEC privately —`,
    `your wallet works in *every* group this bot is in.`,
    ``,
    `📬 *Your Deposit Address:*`,
    `\`${uaAddress}\``,
    ``,
    `This is a Zcash Unified Address (ZIP-316).`,
    `Send ZEC here to top up your tip balance.`,
    ``,
    `*Quick Start:*`,
    `• /balance — check your balance`,
    `• /tip @user 0.001 — tip someone`,
    `• /help — all commands`,
  ].join('\n');
}

function alreadyRegistered(user) {
  return [
    `${LOGO} You're already registered!`,
    ``,
    `📬 Your address: \`${user.ua_address}\``,
    `💰 Balance: *${wallet.formatZec(user.balance_zats)}*`,
  ].join('\n');
}

function balanceMessage(user) {
  const zec = wallet.zatsToZec(user.balance_zats);
  const zats = user.balance_zats.toLocaleString();
  return [
    `💰 *Your Balance*`,
    ``,
    `${ZEC_LOGO} *${zec} ZEC*`,
    `_${zats} zatoshis_`,
    ``,
    `📬 Deposit: \`${user.ua_address}\``,
    ``,
    `_All balances are shielded (Orchard pool)_`,
  ].join('\n');
}

function tipSuccess(sender, receiver, amountZats) {
  return [
    `${ZEC_LOGO} *Tip Sent!*`,
    ``,
    `*${displayName(sender)}* → *${displayName(receiver)}*`,
    `Amount: *${wallet.formatZec(amountZats)}*`,
    ``,
    `_Shielded via Orchard pool (ZIP-224)_`,
  ].join('\n');
}

function withdrawSuccess({ txid, amountZats, toAddress }) {
  return [
    `✅ *Withdrawal Broadcast*`,
    ``,
    `Amount: *${wallet.formatZec(amountZats)}*`,
    `To: \`${shortAddress(toAddress)}\``,
    `TXID: \`${txid}\``,
    ``,
    `_Transaction will confirm in ~1-2 blocks (~75 seconds each)_`,
    `_Track on: https://zcashblockexplorer.com/transactions/${txid}_`,
  ].join('\n');
}

function leaderboard(topTippers, topReceivers, groupTitle) {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    .toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });

  const lines = [`🏆 *${groupTitle} Leaderboard*`, `_Last 30 days (since ${thirtyDaysAgo})_`, ``];

  lines.push(`*Top Tippers 💸*`);
  if (topTippers.length === 0) {
    lines.push(`_No tips yet — be the first!_`);
  } else {
    topTippers.forEach((u, i) => {
      const medal = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'][i] || `${i + 1}.`;
      const name = u.username ? `@${u.username}` : u.first_name;
      lines.push(`${medal} ${name} — *${wallet.formatZec(u.total_sent)}*`);
    });
  }

  lines.push(``);
  lines.push(`*Top Receivers 🎁*`);
  if (topReceivers.length === 0) {
    lines.push(`_No tips received yet_`);
  } else {
    topReceivers.forEach((u, i) => {
      const medal = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'][i] || `${i + 1}.`;
      const name = u.username ? `@${u.username}` : u.first_name;
      lines.push(`${medal} ${name} — *${wallet.formatZec(u.total_received)}*`);
    });
  }

  lines.push(``);
  lines.push(`_${config.community.name}_`);
  return lines.join('\n');
}

function historyMessage(userId, tips) {
  if (tips.length === 0) {
    return `📜 *Tip History*\n\nNo tips yet. Send your first tip with /tip @user 0.001`;
  }

  const lines = [`📜 *Your Last ${tips.length} Tips*`, ``];
  for (const t of tips) {
    const arrow = t.isSent ? `→ ${t.to_username ? '@' + t.to_username : t.to_first_name}` : `← ${t.from_username ? '@' + t.from_username : t.from_first_name}`;
    const sign = t.isSent ? '−' : '+';
    lines.push(`${sign}${wallet.formatZec(t.amount_zats)} ${arrow} _(${t.date})_`);
  }
  return lines.join('\n');
}

function statsMessage(user, stats) {
  return [
    `📊 *Your Stats*`,
    ``,
    `Sent: *${stats.totalSent}* (${stats.sentCount} tips)`,
    `Received: *${stats.totalReceived}* (${stats.receivedCount} tips)`,
    `Biggest tip received: *${stats.largestReceived}*`,
    ``,
    `Balance: *${wallet.formatZec(user.balance_zats)}*`,
  ].join('\n');
}

function rainSuccess({ tippedUsers, perUserZats, totalZats }) {
  const names = tippedUsers.map(u => u.username ? `@${u.username}` : u.first_name).join(', ');
  return [
    `🌧️ *It's Raining ZEC!*`,
    ``,
    `*${wallet.formatZec(perUserZats)}* each → ${tippedUsers.length} users`,
    `Total: *${wallet.formatZec(totalZats)}*`,
    ``,
    `Recipients: ${names}`,
  ].join('\n');
}

function helpMessage() {
  return [
    `${LOGO} *${config.community.name}*`,
    `_Privacy-first ZEC tipping — works in any group I'm added to_`,
    ``,
    `*💸 Tipping*`,
    `• /tip @username 0.001 — tip someone in this group`,
    `• /tip @username $5 — tip using a USD amount`,
    `• /tip 0.001 _(reply to a message)_ — tip the author`,
    `• /rain 0.01 5 — split ZEC among 5 recent active users`,
    ``,
    `_Tips above ${config.tips.largeTipZecThreshold} ZEC or ~$${config.tips.largeTipUsdThreshold} require a quick YES/NO confirmation — just a safety check before larger amounts go out._`,
    ``,
    `*💰 Wallet*`,
    `• /register — create your shielded wallet (works everywhere)`,
    `• /address — show your deposit address`,
    `• /balance — check your balance`,
    `• /withdraw u1... 0.05 — send ZEC to your own wallet`,
    `• /withdraw u1... $5 — withdraw using a USD amount`,
    ``,
    `*📊 Info*`,
    `• /history — your last 10 tips`,
    `• /stats — your personal totals`,
    `• /leaderboard — top tippers in this group`,
    ``,
    `*⚙️ Group Admin*`,
    `• /setmintip 0.0001 — set minimum tip for this group`,
    ``,
    `_All transactions use the Orchard shielded pool (ZIP-224)._`,
    `_Your wallet and balance follow you across every group._`,
  ].join('\n');
}

module.exports = {
  displayName,
  shortAddress,
  welcome,
  alreadyRegistered,
  balanceMessage,
  tipSuccess,
  withdrawSuccess,
  leaderboard,
  historyMessage,
  statsMessage,
  rainSuccess,
  helpMessage,
};
