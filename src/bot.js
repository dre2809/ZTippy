'use strict';

require('dotenv').config();

const { Telegraf, Markup } = require('telegraf');
const cron = require('node-cron');

const config = require('./config');
const db = require('./db');
const wallet = require('./wallet');
const tips = require('./tips');
const withdraw = require('./withdraw');
const amount = require('./amount');
const messages = require('./messages');
const { checkTipLimit, checkRegisterLimit, rateLimitMiddleware } = require('./rateLimiter');
const { RateLimiterMemory } = require('rate-limiter-flexible');
const logger = require('./logger');

// Caps how fast the bot will accept being added to *new* groups.
// Protects against automated mass-add abuse (e.g. a botnet trying to add
// this bot to thousands of groups rapidly), which risks Telegram rate-limiting
// or banning the bot account entirely.
const groupJoinLimiter = new RateLimiterMemory({
  points: 20,    // 20 new groups
  duration: 3600, // per hour, globally across all adds
});

// ─── Startup ──────────────────────────────────────────────────────────────────

logger.info(`Starting ${config.community.name}...`);
logger.info(`Network: ${config.zcash.network}`);
if (wallet.MOCK) logger.warn('MOCK WALLET MODE — not connected to Zcash network');

// Run migrations synchronously before bot starts
db.migrate().catch(err => {
  logger.error('Migration failed:', err);
  process.exit(1);
});

// ─── Bot Init ─────────────────────────────────────────────────────────────────

const bot = new Telegraf(config.telegram.token);

// Global middleware
bot.use(rateLimitMiddleware());

// Update user metadata on every interaction
bot.use(async (ctx, next) => {
  if (ctx.from) {
    const user = await db.users.findById(String(ctx.from.id));
    if (user) {
      const username = ctx.from.username?.toLowerCase() || null;
      await db.users.updateUsername(username, ctx.from.first_name || null, Date.now(), String(ctx.from.id));
    }
  }
  return next();
});

// ─── Helper ──────────────────────────────────────────────────────────────────

function telegramId(ctx) {
  return String(ctx.from.id);
}

async function replyMd(ctx, text) {
  return ctx.reply(text, { parse_mode: 'Markdown' });
}

// Parse a ZEC-only amount string, returns zatoshis or null.
// Used by /rain and /setmintip, which are ZEC-only (USD support is
// /tip and /withdraw only, via amount.parseAmount which also accepts USD).
function parseAmount(amountStr) {
  if (!amountStr) return null;
  try {
    const zats = wallet.zecToZats(amountStr);
    if (zats <= 0n) return null;
    return Number(zats);
  } catch {
    return null;
  }
}

// ─── Auto-Register Groups (Rose-style: zero setup on add) ───────────────────

// Fired when the bot itself (or anyone) is added to a new group.
bot.on('new_chat_members', async (ctx) => {
  const botWasAdded = ctx.message.new_chat_members.some(m => m.id === ctx.botInfo.id);
  if (!botWasAdded) return;

  const groupId = String(ctx.chat.id);

  // Only rate-limit groups we haven't seen before — re-adds after a kick
  // (e.g. admin removed and re-added the bot) shouldn't count against the
  // global join limit.
  const isNewGroup = !(await db.groups.get(groupId));

  if (isNewGroup) {
    try {
      await groupJoinLimiter.consume('global');
    } catch {
      logger.warn(`Group join rate limit hit — declining to onboard ${ctx.chat.title} (${groupId})`);
      await replyMd(ctx, [
        `⚠️ Too many groups are adding this bot right now.`,
        `Please try again in a little while.`,
      ].join('\n')).catch(() => {});
      return ctx.leaveChat().catch(() => {});
    }
  }

  const now = Date.now();

  // Register the group with default settings — no admin config required.
  await db.groups.upsert({
    group_id: groupId,
    group_title: ctx.chat.title || 'Unnamed Group',
    min_tip_zats: config.tips.minZatoshis,
    admin_ids: JSON.stringify([]),
    now,
  });

  logger.info(`Bot added to ${isNewGroup ? 'new' : 'existing'} group: ${ctx.chat.title} (${groupId})`);

  await replyMd(ctx, [
    `${'🛡️'} *${config.community.name} is here!*`,
    ``,
    `Private, shielded ZEC tipping — no setup needed.`,
    ``,
    `*Get started:*`,
    `• /register — create your wallet`,
    `• /tip @user 0.001 — tip someone`,
    `• /help — see everything I can do`,
    ``,
    `_Group admins: if you'd rather not have this bot here, just remove it — no data is kept that's specific to this group beyond tip history and settings._`,
  ].join('\n'));
});

// ─── /credit (bot owner only — manual deposit credit) ────────────────────────

bot.command('credit', async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  if (!config.telegram.ownerId || telegramId(ctx) !== config.telegram.ownerId) return;

  const args = ctx.message.text.split(/\s+/).slice(1);
  if (args.length < 3) {
    return replyMd(ctx, [
      `*Manual Deposit Credit*`,
      ``,
      `Usage: /credit <telegram_id> <txid> <amount_zec>`,
      `Example: /credit 123456789 abc123... 0.5`,
      ``,
      `_Use this to manually credit a deposit that the scanner missed._`,
    ].join('\n'));
  }

  const [targetId, txid, amountStr] = args;
  const user = await db.users.findById(targetId);
  if (!user) return replyMd(ctx, `❌ User ${targetId} not found.`);

  let amountZats;
  try {
    amountZats = Number(wallet.zecToZats(amountStr));
    if (!amountZats || amountZats <= 0) throw new Error('invalid');
  } catch {
    return replyMd(ctx, '❌ Invalid amount.');
  }

  // Check if this txid has already been credited
  const existing = await db.execute(
    'SELECT id FROM deposits WHERE telegram_id = ? AND txid = ?',
    [targetId, txid]
  ).then(r => r.rows[0]);

  if (existing) {
    return replyMd(ctx, `❌ This transaction has already been credited to @${user.username || targetId}.`);
  }

  await db.execute(
    'UPDATE users SET balance_zats = balance_zats + ? WHERE telegram_id = ?',
    [amountZats, targetId]
  );
  await db.execute(
    'INSERT INTO deposits (telegram_id, txid, amount_zats, block_height, credited_at) VALUES (?, ?, ?, 0, ?)',
    [targetId, txid, amountZats, Date.now()]
  );
  await db.syncToTurso();

  const updated = await db.users.findById(targetId);
  return replyMd(ctx, [
    `✅ *Manual credit applied*`,
    ``,
    `User: @${user.username || targetId}`,
    `Amount: *${wallet.formatZec(amountZats)}*`,
    `New balance: *${wallet.formatZec(updated.balance_zats)}*`,
  ].join('\n'));
});

bot.command('stats_global', async (ctx) => {
  if (ctx.chat.type !== 'private') {
    return; // silently ignore in groups — don't leak that this command exists
  }
  if (!config.telegram.ownerId || telegramId(ctx) !== config.telegram.ownerId) {
    return; // silently ignore for non-owners
  }

  const [gc, uc, tc, tt, wc] = await Promise.all([
    db.execute('SELECT COUNT(*) as c FROM group_settings').then(r => r.rows[0].c),
    db.execute('SELECT COUNT(*) as c FROM users').then(r => r.rows[0].c),
    db.execute('SELECT COUNT(*) as c FROM tips').then(r => r.rows[0].c),
    db.execute('SELECT COALESCE(SUM(amount_zats),0) as s FROM tips').then(r => r.rows[0].s),
    db.execute("SELECT COUNT(*) as c FROM withdrawals WHERE status = 'broadcast'").then(r => r.rows[0].c),
  ]);
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const activeGroups7d = await db.execute('SELECT COUNT(DISTINCT group_id) as c FROM tips WHERE created_at >= ?', [sevenDaysAgo]).then(r => r.rows[0].c);
  const [groupCount, userCount, tipCount, totalTipped, withdrawalCount] = [gc, uc, tc, tt, wc];

  return replyMd(ctx, [
    `📊 *Global Bot Stats*`,
    ``,
    `Groups: *${groupCount}* (${activeGroups7d} active in last 7d)`,
    `Registered users: *${userCount}*`,
    `Total tips sent: *${tipCount}*`,
    `Total volume: *${wallet.formatZec(totalTipped)}*`,
    `Withdrawals broadcast: *${withdrawalCount}*`,
  ].join('\n'));
});

// ─── /leave (group admins or bot owner only) ─────────────────────────────────

bot.command('leave', async (ctx) => {
  if (ctx.chat.type === 'private') {
    return replyMd(ctx, '❌ This command only works inside a group.');
  }

  const isOwner = config.telegram.ownerId && telegramId(ctx) === config.telegram.ownerId;
  let isAdmin = isOwner;

  if (!isAdmin) {
    const member = await ctx.getChatMember(ctx.from.id).catch(() => null);
    isAdmin = member && ['administrator', 'creator'].includes(member.status);
  }

  if (!isAdmin) {
    return replyMd(ctx, '❌ Only group admins can remove the bot.');
  }

  await replyMd(ctx, '👋 Leaving this group. Thanks for having me!');
  return ctx.leaveChat();
});

// ─── /start & /help ──────────────────────────────────────────────────────────

bot.start(async (ctx) => {
  await replyMd(ctx, messages.helpMessage());
});

bot.help(async (ctx) => {
  await replyMd(ctx, messages.helpMessage());
});

bot.command('help', async (ctx) => {
  await replyMd(ctx, messages.helpMessage());
});

// ─── /register ───────────────────────────────────────────────────────────────

bot.command('register', async (ctx) => {
  const id = telegramId(ctx);
  const existing = await db.users.findById(id);

  if (existing) {
    return replyMd(ctx, messages.alreadyRegistered(existing));
  }

  const rateLimitOk = await checkRegisterLimit(id);
  if (!rateLimitOk) {
    return replyMd(ctx, '⚠️ Please wait a few minutes before registering again.');
  }

  // Derive next diversifier index
  const maxResult = await db.users.getMaxDivIndex();
  const nextDivIndex = (maxResult.max_idx ?? -1) + 1;

  // Derive unique u1... address
  let uaAddress;
  try {
    uaAddress = await wallet.deriveAddress(nextDivIndex);
  } catch (err) {
    logger.error('Address derivation failed:', err);
    return replyMd(ctx, '❌ Registration failed. Please try again or contact an admin.');
  }

  // Store user
  try {
    await db.users.create({
      telegram_id: id,
      username: ctx.from.username?.toLowerCase() || null,
      first_name: ctx.from.first_name || null,
      div_index: nextDivIndex,
      ua_address: uaAddress,
      registered_at: Date.now(),
    });
  } catch (err) {
    logger.error('User creation failed:', err);
    return replyMd(ctx, '❌ Registration failed. Please try again.');
  }

  logger.info(`New user registered: ${id} (@${ctx.from.username}) | div_index: ${nextDivIndex}`);

  // Claim any pending balances sent to this username before registration
  const username = ctx.from.username?.toLowerCase();
  let pendingTotal = 0;
  if (username) {
    const pending = await db.execute(
      'SELECT SUM(amount_zats) as total FROM pending_balances WHERE to_username = ?',
      [username]
    ).then(r => r.rows[0]);

    if (pending?.total > 0) {
      pendingTotal = pending.total;
      await db.execute(
        'UPDATE users SET balance_zats = balance_zats + ? WHERE telegram_id = ?',
        [pendingTotal, id]
      );
      await db.execute(
        'DELETE FROM pending_balances WHERE to_username = ?',
        [username]
      );
      await db.syncToTurso();
      logger.info(`Claimed ${wallet.formatZec(pendingTotal)} pending balance for @${username}`);
    }
  }

  const welcomeMsg = messages.welcome(ctx.from, uaAddress);
  if (pendingTotal > 0) {
    return replyMd(ctx, welcomeMsg + `\n\n🎉 You had *${wallet.formatZec(pendingTotal)}* waiting for you from tips sent before you registered!`);
  }
  return replyMd(ctx, welcomeMsg);
});

// ─── /address ────────────────────────────────────────────────────────────────

bot.command('address', async (ctx) => {
  const user = await db.users.findById(telegramId(ctx));
  if (!user) return replyMd(ctx, '❌ You are not registered. Use /register to get started.');

  return replyMd(ctx, [
    `📬 *Your Deposit Address*`,
    ``,
    `\`${user.ua_address}\``,
    ``,
    `_Unified Address (ZIP-316) — Orchard shielded pool_`,
    `_Send ZEC here to top up your balance._`,
  ].join('\n'));
});

// ─── /balance ────────────────────────────────────────────────────────────────

bot.command('balance', async (ctx) => {
  const user = await db.users.findById(telegramId(ctx));
  if (!user) return replyMd(ctx, '❌ You are not registered. Use /register to get started.');

  return replyMd(ctx, messages.balanceMessage(user));
});

// ─── /tip ────────────────────────────────────────────────────────────────────

bot.command('tip', async (ctx) => {
  const id = telegramId(ctx);
  const args = ctx.message.text.split(/\s+/).slice(1);

  // Rate limit check
  const allowed = await checkTipLimit(id);
  if (!allowed) {
    return replyMd(ctx, `⚠️ You're tipping too fast. Max ${config.security.tipRateLimitPerMinute} tips per minute.`);
  }

  let targetUsername = null;
  let amountStr = null;

  // Parse: /tip @username 0.001 | /tip @username $5 | /tip @username 5 usd
  //     or: /tip 0.001 (reply)  | /tip $5 (reply)    | /tip 5 usd (reply)
  if (args.length >= 1 && args[0].startsWith('@')) {
    targetUsername = args[0];
    amountStr = args.slice(1).join(' '); // supports "5 usd" as two tokens
  } else if (args.length >= 1) {
    amountStr = args.join(' ');
  }

  if (targetUsername && !amountStr) {
    return replyMd(ctx, '❌ Usage: /tip @username 0.001 or reply to a message with /tip 0.001\nUSD also works: /tip @username $5');
  }

  let parsed;
  try {
    parsed = await amount.parseAmount(amountStr);
  } catch (err) {
    if (err.message === 'PRICE_UNAVAILABLE') {
      return replyMd(ctx, '❌ Could not fetch the current ZEC price for your USD amount. Please try again shortly, or use a ZEC amount instead.');
    }
    throw err;
  }

  if (!parsed) {
    return replyMd(ctx, '❌ Invalid amount. Example: /tip @username 0.001  or  /tip @username $5');
  }

  const amountZats = Number(parsed.amountZats);

  const sender = await db.users.findById(id);
  if (!sender) return replyMd(ctx, '❌ You are not registered. Use /register first.');

  // Try to resolve receiver — may be null if not registered
  const receiver = await tips.resolveTarget(ctx, targetUsername);

  // If no receiver found and it's a reply-tip (no username), we can't identify them
  if (!receiver && !targetUsername) {
    return replyMd(ctx, '❌ User not found. They need to /register first.');
  }

  const result = await tips.initiateTip({
    senderId: id,
    receiverId: receiver?.telegram_id || null,
    receiverUsername: targetUsername,
    amountZats,
    ctx,
  });

  if (!result.success) return replyMd(ctx, `❌ ${result.reason}`);
  if (result.requiresConfirmation) return replyMd(ctx, result.prompt);

  // Pending tip — recipient not yet registered
  if (result.pending) {
    return replyMd(ctx, [
      `✅ *Tip queued!*`,
      ``,
      `*${result.formattedAmount}* is being held for @${result.username}.`,
      `They'll receive it automatically when they /register.`,
    ].join('\n'));
  }

  return replyMd(ctx, messages.tipSuccess(result.sender, result.receiver, result.amountZats));
});

// ─── /rain ───────────────────────────────────────────────────────────────────

bot.command('rain', async (ctx) => {
  const id = telegramId(ctx);
  const args = ctx.message.text.split(/\s+/).slice(1);

  if (args.length < 2) {
    return replyMd(ctx, '❌ Usage: /rain <amount> <number_of_users>\nExample: /rain 0.05 5');
  }

  const amountZats = parseAmount(args[0]);
  const numRecipients = parseInt(args[1], 10);

  if (!amountZats) return replyMd(ctx, '❌ Invalid amount. Example: /rain 0.05 5');
  if (!numRecipients || numRecipients < 1) return replyMd(ctx, '❌ Invalid number of users.');

  const result = await tips.executeRain({ senderId: id, totalAmountZats: amountZats, numRecipients, ctx });

  if (!result.success) return replyMd(ctx, `❌ ${result.reason}`);
  return replyMd(ctx, messages.rainSuccess(result));
});

// ─── /withdraw ───────────────────────────────────────────────────────────────

const intents = require('./intents');

// In-memory store for multi-step intent withdrawal state
const intentState = new Map();

bot.command('withdraw', async (ctx) => {
  const id = telegramId(ctx);
  const user = await db.users.findById(id);
  if (!user) return replyMd(ctx, '❌ You are not registered. Use /register first.');
  if (!user.balance_zats || user.balance_zats <= 0) return replyMd(ctx, '❌ Your balance is 0. Deposit ZEC first.');

  const args = ctx.message.text.split(/\s+/).slice(1);
  if (!args[0]) {
    return replyMd(ctx, [
      `💸 *Withdraw ZEC*\n`,
      `Usage: /withdraw <amount>`,
      `Example: /withdraw 0.05`,
      ``,
      `You will be asked where to send it.`,
    ].join('\n'));
  }

  const amountInput = args.join(' ');
  let parsed;
  try {
    parsed = await amount.parseAmount(amountInput);
  } catch (err) {
    if (err.message === 'PRICE_UNAVAILABLE') return replyMd(ctx, '❌ Could not fetch ZEC price. Use a ZEC amount instead.');
    throw err;
  }
  if (!parsed) return replyMd(ctx, '❌ Invalid amount. Example: /withdraw 0.05');

  const amountZats = Number(parsed.amountZats);
  if (amountZats > user.balance_zats) return replyMd(ctx, `❌ Insufficient balance. Your balance: ${wallet.formatZec(user.balance_zats)}`);

  // Store amount and ask destination type
  intentState.set(id, { step: 'type', amountZats });

  await ctx.reply('💸 *Where do you want to withdraw?*', {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🛡 Zcash Address (ZEC)', callback_data: 'wd_type_zec' }],
        [{ text: '🌐 Swap to Another Token', callback_data: 'wd_type_swap' }],
      ],
    },
  });
});

// Step 1 — Type selection
bot.action('wd_type_zec', async (ctx) => {
  await ctx.answerCbQuery();
  const id = String(ctx.from.id);
  const state = intentState.get(id);
  if (!state) return ctx.reply('Session expired. Please run /withdraw again.');

  intentState.set(id, { ...state, step: 'zec_address' });
  await ctx.editMessageText(
    `🛡 *Withdraw to Zcash Address*\n\nAmount: *${wallet.formatZec(state.amountZats)}*\n\nPlease send your Unified Address (u1...):`,
    { parse_mode: 'Markdown' }
  );
});

bot.action('wd_type_swap', async (ctx) => {
  await ctx.answerCbQuery();
  const id = String(ctx.from.id);
  const state = intentState.get(id);
  if (!state) return ctx.reply('Session expired. Please run /withdraw again.');

  intentState.set(id, { ...state, step: 'chain' });

  const chains = Object.entries(intents.CHAIN_LABELS).map(([key, label]) => ([
    { text: label, callback_data: `wd_chain_${key}` },
  ]));

  await ctx.editMessageText(
    `🌐 *Select destination chain:*\n\nAmount: *${wallet.formatZec(state.amountZats)}*`,
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: chains },
    }
  );
});

// Step 2 — Chain selection
Object.keys(intents.CHAIN_LABELS).forEach(chain => {
  bot.action(`wd_chain_${chain}`, async (ctx) => {
    await ctx.answerCbQuery();
    const id = String(ctx.from.id);
    const state = intentState.get(id);
    if (!state) return ctx.reply('Session expired. Please run /withdraw again.');

    intentState.set(id, { ...state, step: 'token', chain });

    const tokens = Object.keys(intents.SUPPORTED_TOKENS[chain]).map(symbol => ([
      { text: symbol, callback_data: `wd_token_${chain}_${symbol}` },
    ]));

    await ctx.editMessageText(
      `${intents.CHAIN_LABELS[chain]} — *Select token:*`,
      {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: tokens },
      }
    );
  });
});

// Step 3 — Token selection
Object.entries(intents.SUPPORTED_TOKENS).forEach(([chain, tokens]) => {
  Object.keys(tokens).forEach(symbol => {
    bot.action(`wd_token_${chain}_${symbol}`, async (ctx) => {
      await ctx.answerCbQuery();
      const id = String(ctx.from.id);
      const state = intentState.get(id);
      if (!state) return ctx.reply('Session expired. Please run /withdraw again.');

      intentState.set(id, { ...state, step: 'address', token: symbol });

      await ctx.editMessageText(
        `*${symbol}* on ${intents.CHAIN_LABELS[chain]}\n\nPlease send your *${symbol} destination address*:`,
        { parse_mode: 'Markdown' }
      );
    });
  });
});

// Step 4 — Address input (text handler)
bot.on('text', async (ctx, next) => {
  const id = String(ctx.from.id);
  const state = intentState.get(id);
  if (!state) return next();

  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return next(); // ignore commands

  // ZEC address flow
  if (state.step === 'zec_address') {
    intentState.delete(id);
    const toAddress = text;
    const amountInput = String(state.amountZats / 1e8);
    const result = await withdraw.initiateWithdrawal({ telegramId: id, toAddress, amountInput });
    if (!result.success) return replyMd(ctx, `❌ ${result.reason}`);
    if (result.requiresConfirmation) return replyMd(ctx, result.prompt);
    return;
  }

  // NEAR Intents swap flow — waiting for destination address
  if (state.step === 'address') {
    intentState.set(id, { ...state, step: 'confirming', recipient: text });

    await replyMd(ctx, `⏳ Fetching quote...`);

    try {
      const user = await db.users.findById(id);
      const quote = await intents.getSwapQuote({
        amountZats: state.amountZats,
        chain: state.chain,
        token: state.token,
        recipient: text,
        refundAddress: user.ua_address,
      });

      intentState.set(id, { ...state, step: 'confirmed', recipient: text, quote });

      await ctx.reply(
        intents.formatQuote(quote, state.amountZats) + `\n\nSend *YES* to confirm or *NO* to cancel.`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ Confirm', callback_data: 'wd_intent_confirm' },
              { text: '❌ Cancel', callback_data: 'wd_intent_cancel' },
            ]],
          },
        }
      );
    } catch (err) {
      intentState.delete(id);
      logger.error('Intent quote error:', err.message);
      return replyMd(ctx, `❌ Could not get swap quote: ${err.message}`);
    }
    return;
  }

  return next();
});

// Step 5 — Confirm/cancel swap
bot.action('wd_intent_confirm', async (ctx) => {
  await ctx.answerCbQuery();
  const id = String(ctx.from.id);
  const state = intentState.get(id);
  if (!state?.quote) return ctx.reply('Session expired. Please run /withdraw again.');

  intentState.delete(id);

  // Debit user balance
  const user = await db.users.findById(id);
  if (user.balance_zats < state.amountZats) {
    return replyMd(ctx, '❌ Insufficient balance.');
  }

  await db.execute('UPDATE users SET balance_zats = balance_zats - ? WHERE telegram_id = ?', [state.amountZats, id]);
  await db.execute(
    'INSERT INTO withdrawals (telegram_id, to_address, amount_zats, fee_zats, status, created_at) VALUES (?, ?, ?, 0, ?, ?)',
    [id, state.quote.depositAddress, state.amountZats, 'intent_pending', Date.now()]
  );
  await db.syncToTurso();

  await ctx.editMessageText(
    [
      `✅ *Swap initiated via NEAR Intents!*\n`,
      `Send *${wallet.formatZec(state.amountZats)}* to:`,
      `\`${state.quote.depositAddress}\``,
      ``,
      `Your ${state.token} will arrive at:`,
      `\`${state.quote.recipient}\``,
      ``,
      `Expected: *${state.quote.amountOutFormatted} ${state.token}*`,
      `Est. time: ~${Math.ceil(state.quote.timeEstimate / 60)} min`,
      ``,
      `If the swap fails, ZEC is automatically refunded to your tipbot address.`,
    ].join('\n'),
    { parse_mode: 'Markdown' }
  );
});

bot.action('wd_intent_cancel', async (ctx) => {
  await ctx.answerCbQuery();
  const id = String(ctx.from.id);
  intentState.delete(id);
  await ctx.editMessageText('❌ Swap cancelled.');
});

// ─── YES/NO confirmation handler ─────────────────────────────────────────────

bot.hears(/^(YES|NO|yes|no)$/i, async (ctx) => {
  const id = telegramId(ctx);
  const response = ctx.message.text.toUpperCase();
  const now = Date.now();

  // Check for either kind of pending confirmation — withdrawal or large tip.
  // Whichever was created more recently wins if (improbably) both are pending.
  const [pendingWithdrawal, pendingTip] = await Promise.all([
    db.confirmations.get(id, 'withdrawal', now),
    db.confirmations.get(id, 'tip', now),
  ]);

  if (!pendingWithdrawal && !pendingTip) return; // Not a confirmation context, ignore

  const isTip = pendingTip && (!pendingWithdrawal || pendingTip.created_at > pendingWithdrawal.created_at);

  if (response === 'NO') {
    if (isTip) {
      tips.cancelTip(id);
      return replyMd(ctx, '❌ Tip cancelled.');
    }
    withdraw.cancelWithdrawal(id);
    return replyMd(ctx, '❌ Withdrawal cancelled.');
  }

  if (response === 'YES') {
    if (isTip) {
      const result = await tips.confirmTip(id, ctx);
      if (!result.success) return replyMd(ctx, `❌ ${result.reason}`);
      return replyMd(ctx, messages.tipSuccess(result.sender, result.receiver, result.amountZats));
    }
    const result = await withdraw.confirmWithdrawal(id);
    if (!result.success) return replyMd(ctx, `❌ ${result.reason}`);
    return replyMd(ctx, messages.withdrawSuccess(result));
  }
});

// ─── /history ────────────────────────────────────────────────────────────────

bot.command('history', async (ctx) => {
  const id = telegramId(ctx);
  const user = await db.users.findById(id);
  if (!user) return replyMd(ctx, '❌ You are not registered. Use /register first.');

  const history = await tips.getTipHistory(id);
  return replyMd(ctx, messages.historyMessage(id, history));
});

// ─── /stats ──────────────────────────────────────────────────────────────────

bot.command('stats', async (ctx) => {
  const id = telegramId(ctx);
  const user = await db.users.findById(id);
  if (!user) return replyMd(ctx, '❌ You are not registered. Use /register first.');

  const userStats = await tips.getUserStats(id);
  return replyMd(ctx, messages.statsMessage(user, userStats));
});

// ─── /leaderboard ────────────────────────────────────────────────────────────

bot.command('leaderboard', async (ctx) => {
  if (ctx.chat.type === 'private') {
    return replyMd(ctx, '❌ Leaderboard is only available in group chats.');
  }

  const groupId = String(ctx.chat.id);
  const groupTitle = ctx.chat.title || 'This Group';
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

  const [topTippers, topReceivers] = await Promise.all([
    db.users.getTopTippers(groupId, thirtyDaysAgo),
    db.users.getTopReceivers(groupId, thirtyDaysAgo),
  ]);

  return replyMd(ctx, messages.leaderboard(topTippers, topReceivers, groupTitle));
});

// ─── /setmintip (admin only) ──────────────────────────────────────────────────

bot.command('setmintip', async (ctx) => {
  if (ctx.chat.type === 'private') {
    return replyMd(ctx, '❌ This command is only for group admins.');
  }

  // Verify admin
  const member = await ctx.getChatMember(ctx.from.id).catch(() => null);
  const isAdmin = member && ['administrator', 'creator'].includes(member.status);
  if (!isAdmin) return replyMd(ctx, '❌ Only group admins can set the minimum tip.');

  const args = ctx.message.text.split(/\s+/).slice(1);
  const amountZats = parseAmount(args[0]);
  if (!amountZats || amountZats < 1000) {
    return replyMd(ctx, '❌ Invalid amount. Minimum is 0.00001 ZEC (1000 zatoshis).');
  }

  const groupId = String(ctx.chat.id);
  const now = Date.now();

  await db.groups.upsert({
    group_id: groupId,
    group_title: ctx.chat.title,
    min_tip_zats: amountZats,
    admin_ids: JSON.stringify([String(ctx.from.id)]),
    now,
  });

  return replyMd(ctx, `✅ Minimum tip set to *${wallet.formatZec(amountZats)}* for this group.`);
});

// ─── Error Handler ────────────────────────────────────────────────────────────

bot.catch((err, ctx) => {
  logger.error(`Bot error for update ${ctx.updateType}:`, err);
  ctx.reply('❌ An unexpected error occurred. Please try again.').catch(() => {});
});

// ─── Cron Jobs ────────────────────────────────────────────────────────────────

// Clean up expired confirmations every 5 minutes
cron.schedule('*/5 * * * *', async () => {
  await db.confirmations.cleanExpired(Date.now());
  logger.debug('Cleaned expired confirmations');
});

// ─── Launch ───────────────────────────────────────────────────────────────────

bot.launch({
  allowedUpdates: ['message', 'callback_query'],
}).then(() => {
  logger.info(`✅ ${config.community.name} is live!`);
}).catch((err) => {
  logger.error('Failed to launch bot:', err);
  process.exit(1);
});

// Graceful shutdown
process.once('SIGINT', () => {
  logger.info('Shutting down...');
  bot.stop('SIGINT');
});
process.once('SIGTERM', () => {
  logger.info('Shutting down...');
  bot.stop('SIGTERM');
});
