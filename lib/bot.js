const { Telegraf, Markup } = require('telegraf');
const { BRANDS, CATEGORIES, WALLET_CATEGORIES } = require('./categories');
const {
  appendExpense,
  getTodayExpenseRows,
  appendWalletTransaction,
  getWalletBalance,
  getAllWalletBalances,
  appendReimbursement,
  getPendingReimbursements,
  findReimbursementById,
  settleReimbursement,
  findUser,
  nicknameTaken,
  registerUser,
  setUserStatus,
  getBudgets,
  getMonthlySummary,
} = require('./sheets');

// webhookReply (Telegraf's default) piggybacks the FIRST outgoing API call
// (e.g. answerCallbackQuery) onto the webhook's own HTTP response back to
// Telegram — which means our serverless function's response is sent, and
// its fate (frozen vs kept alive), before the real work (Sheets reads,
// the actual reply/edit) is anywhere close to done. That race is almost
// certainly why replies have been landing inconsistently. Disabling it
// forces every Telegram API call over the network normally, so our own
// `await bot.handleUpdate(...)` in api/webhook.js only resolves — and only
// then do we respond to Telegram — once all of it has actually finished.
const bot = new Telegraf(process.env.BOT_TOKEN, { telegram: { webhookReply: false } });

const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function isAdmin(id) {
  return ADMIN_IDS.includes(String(id));
}

function formatMoney(n) {
  return Math.round(n).toLocaleString('en-US') + ' UZS';
}

function telegramLabel(ctx) {
  return ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
}

// Sends an immediate "something is happening" message, to be edited in
// place once the real (possibly slow) Sheets lookup finishes — so a tap
// always produces something on screen right away instead of dead air
// while we wait on the network.
async function replyPlaceholder(ctx) {
  return ctx.reply('⏳ One sec...');
}

const TELEGRAM_CALL_TIMEOUT_MS = 8000;

function withTelegramTimeout(promise, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Telegram API call timed out after ${TELEGRAM_CALL_TIMEOUT_MS}ms (${label})`)), TELEGRAM_CALL_TIMEOUT_MS);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

// Edits the placeholder in place — but if that call itself fails or hangs
// (same class of network flakiness we've seen on the Sheets side, just on
// Telegram's end this time), falls back to sending a brand new message so
// the user is never just left staring at "One sec..." with nothing further.
async function editPlaceholder(ctx, placeholder, text) {
  try {
    await withTelegramTimeout(
      ctx.telegram.editMessageText(placeholder.chat.id, placeholder.message_id, undefined, text),
      'editMessageText'
    );
  } catch (err) {
    console.error('Failed to edit placeholder message, sending a new one instead:', err);
    try {
      await ctx.reply(text);
    } catch (err2) {
      console.error('Fallback reply also failed:', err2);
    }
  }
}

// Checks registration + approval status. Replies with a friendly message and
// returns null if the user can't proceed; otherwise returns { telegramId, nickname, isAdmin }.
async function requireApproved(ctx) {
  const userId = ctx.from.id;
  if (isAdmin(userId)) {
    return { telegramId: userId, nickname: telegramLabel(ctx), isAdmin: true };
  }

  const found = await findUser(userId);
  if (!found) {
    await ctx.reply("You'll need to register first — send /start.");
    return null;
  }
  const status = found.values[3];
  if (status === 'Pending') {
    await ctx.reply('⏳ Your registration is still awaiting admin approval.');
    return null;
  }
  if (status === 'Denied') {
    await ctx.reply('🚫 Your access request was denied. Contact an admin if this seems wrong.');
    return null;
  }
  return { telegramId: userId, nickname: found.values[2], isAdmin: false };
}

function brandKeyboard(prefix) {
  const rows = BRANDS.map((b) => [Markup.button.callback(b.label, `${prefix}${b.id}`)]);
  rows.push([Markup.button.callback('❌ Cancel', 'cancel_flow')]);
  return Markup.inlineKeyboard(rows);
}

function categoryKeyboard(categories, prefix, backAction) {
  const buttons = categories.map((c) => Markup.button.callback(c, `${prefix}${c}`));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  rows.push([Markup.button.callback('🔙 Back', backAction), Markup.button.callback('❌ Cancel', 'cancel_flow')]);
  return Markup.inlineKeyboard(rows);
}

function mainMenuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('💵 Log expense', 'menu_expense'), Markup.button.callback('🏦 Direct payment', 'menu_directpay')],
    [Markup.button.callback('➕ Top up wallet', 'menu_advance'), Markup.button.callback('↩️ Return cash', 'menu_return')],
    [Markup.button.callback('🧾 Reimburse me', 'menu_reimburse'), Markup.button.callback('📋 Owed', 'menu_owed')],
    [Markup.button.callback('👛 My wallet', 'menu_wallet'), Markup.button.callback('👥 All wallets', 'menu_wallets')],
    [Markup.button.callback('📊 Report', 'menu_report'), Markup.button.callback('📅 Today', 'menu_today')],
  ]);
}

// A prompt's routing info, plain text on its own line with a note that it's
// not meant to be typed — this is what the bot reads back to know which
// question it asked, not something the person needs to interact with.
function tagLine(value) {
  return `(the code below is just for the bot — ignore it)\n[${value}]`;
}

const FORCE_REPLY = { reply_markup: { force_reply: true, selective: true } };

// Parses "amount rest-of-text" — one number, then free text after.
function parseAmountAndText(text) {
  const m = text.trim().match(/^([\d.,]+)\s*(.*)$/);
  if (!m) return null;
  const amount = parseFloat(m[1].replace(/,/g, ''));
  if (!amount || Number.isNaN(amount)) return null;
  return { amount, rest: m[2] || '' };
}

/* ------------------------------------------------------------------ */
/* Start / registration / help                                         */
/* ------------------------------------------------------------------ */

async function sendMainMenu(ctx, nickname) {
  await ctx.reply([`Hi ${nickname}! 👋`, '', 'What would you like to do?'].join('\n'), mainMenuKeyboard());
}

bot.start(async (ctx) => {
  const userId = ctx.from.id;
  if (isAdmin(userId)) return sendMainMenu(ctx, telegramLabel(ctx));

  const found = await findUser(userId);
  if (!found) {
    return ctx.reply(
      [
        'Welcome to the Little Britain / WorldLink Expense Bot! 👋',
        '',
        "Before you start, what should I call you? (a short nickname is fine)",
        '',
        tagLine(`register: ${userId}`),
      ].join('\n'),
      FORCE_REPLY
    );
  }

  const status = found.values[3];
  if (status === 'Pending') return ctx.reply('⏳ Your registration is still awaiting admin approval.');
  if (status === 'Denied') return ctx.reply('🚫 Your access request was denied. Contact an admin if this seems wrong.');
  return sendMainMenu(ctx, found.values[2]);
});

bot.command('cancel', (ctx) => ctx.reply('Okay — cancelled, nothing was saved. Send /start to see what you can do.'));

bot.command('getid', (ctx) => {
  ctx.reply(`This chat's ID is: ${ctx.chat.id}`);
});

bot.action('cancel_flow', async (ctx) => {
  await ctx.answerCbQuery('Cancelled');
  await ctx.editMessageText('❌ Cancelled — nothing was saved.');
});

bot.action(/^appr_(.+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admins only', { show_alert: true });
  const telegramId = ctx.match[1];
  await setUserStatus(telegramId, 'Approved', telegramLabel(ctx));
  await ctx.answerCbQuery('Approved');
  await ctx.editMessageText(`${ctx.callbackQuery.message.text}\n\n✅ Approved by ${telegramLabel(ctx)}.`);
  try {
    await bot.telegram.sendMessage(telegramId, "✅ You're approved! Send /start to begin.");
  } catch (err) {
    console.error('Failed to notify approved user:', err);
  }
});

bot.action(/^deny_(.+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admins only', { show_alert: true });
  const telegramId = ctx.match[1];
  await setUserStatus(telegramId, 'Denied', telegramLabel(ctx));
  await ctx.answerCbQuery('Denied');
  await ctx.editMessageText(`${ctx.callbackQuery.message.text}\n\n🚫 Denied by ${telegramLabel(ctx)}.`);
  try {
    await bot.telegram.sendMessage(telegramId, '🚫 Your access request was denied.');
  } catch (err) {
    console.error('Failed to notify denied user:', err);
  }
});

/* ------------------------------------------------------------------ */
/* Brand → category → amount flows (expense / direct payment / top-up) */
/* ------------------------------------------------------------------ */

function registerMoneyFlow({ command, menuAction, brandPrefix, catPrefix, backAction, brandQuestion, catQuestionFn, promptFn, categories }) {
  async function start(ctx) {
    const user = await requireApproved(ctx);
    if (!user) return;
    await ctx.reply(brandQuestion, brandKeyboard(brandPrefix));
  }

  bot.command(command, start);

  bot.action(menuAction, async (ctx) => {
    await ctx.answerCbQuery();
    const user = await requireApproved(ctx);
    if (!user) return;
    await ctx.reply(brandQuestion, brandKeyboard(brandPrefix));
  });

  bot.action(new RegExp(`^${brandPrefix}(.+)$`), async (ctx) => {
    const brandId = ctx.match[1];
    const brand = BRANDS.find((b) => b.id === brandId);
    if (!brand) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    await ctx.editMessageText(catQuestionFn(brand), categoryKeyboard(categories, `${catPrefix}${brandId}__`, backAction));
  });

  bot.action(backAction, async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(brandQuestion, brandKeyboard(brandPrefix));
  });

  bot.action(new RegExp(`^${catPrefix}(.+)__(.+)$`), async (ctx) => {
    const [, brandId, category] = ctx.match;
    const brand = BRANDS.find((b) => b.id === brandId);
    // Guards against a stale keyboard from before a category was moved
    // between /expense and /directpay — not just trusting the tapped data.
    if (!brand || !categories.includes(category)) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    await ctx.reply(promptFn(brand, category), FORCE_REPLY);
  });
}

registerMoneyFlow({
  command: 'expense',
  menuAction: 'menu_expense',
  brandPrefix: 'expbrand_',
  catPrefix: 'expcat_',
  backAction: 'back_expbrand',
  brandQuestion: '💵 Which brand is this cash expense for?',
  catQuestionFn: (brand) => `${brand.label} — choose a category:`,
  categories: WALLET_CATEGORIES,
  promptFn: (brand, category) =>
    [
      `📝 ${brand.label} — ${category} (paid from your wallet)`,
      'Type the amount, then a short description.',
      'Example: 150000 taxi to warehouse',
      '',
      tagLine(`exp: ${brand.id}|${category}`),
    ].join('\n'),
});

registerMoneyFlow({
  command: 'directpay',
  menuAction: 'menu_directpay',
  brandPrefix: 'dpbrand_',
  catPrefix: 'dpcat_',
  backAction: 'back_dpbrand',
  brandQuestion: "🏦 Which brand is this direct payment for? (rent, salary, bank transfer — not from your cash wallet)",
  catQuestionFn: (brand) => `${brand.label} — choose a category:`,
  categories: CATEGORIES,
  promptFn: (brand, category) =>
    [
      `📝 ${brand.label} — ${category} (direct payment)`,
      'Type the amount, then a short description.',
      'Example: 1500000 July office rent',
      '',
      tagLine(`direct: ${brand.id}|${category}`),
    ].join('\n'),
});

registerMoneyFlow({
  command: 'reimburse',
  menuAction: 'menu_reimburse',
  brandPrefix: 'rbbrand_',
  catPrefix: 'rbcat_',
  backAction: 'back_rbbrand',
  brandQuestion: "🧾 Which brand is this reimbursement for? (you paid from your own pocket)",
  catQuestionFn: (brand) => `${brand.label} — choose a category:`,
  categories: CATEGORIES,
  promptFn: (brand, category) =>
    [
      `🧾 ${brand.label} — ${category} (reimbursement — paid from your own pocket)`,
      'Type the amount, then a short description.',
      'Example: 80000 printer paper, paid cash',
      '',
      tagLine(`reimb: ${brand.id}|${category}`),
    ].join('\n'),
});

/* ------------------------------------------------------------------ */
/* Top up wallet (no brand/category — it's just cash, categories apply */
/* when it's actually spent via /expense)                              */
/* ------------------------------------------------------------------ */

async function startAdvance(ctx) {
  const user = await requireApproved(ctx);
  if (!user) return;
  await ctx.reply(
    [
      "➕ How much cash are you taking to top up your wallet?",
      "Just the number, then an optional note. Example: 500000 weekly float",
      '',
      tagLine('advtopup: '),
    ].join('\n'),
    FORCE_REPLY
  );
}

bot.command('advance', startAdvance);
bot.action('menu_advance', async (ctx) => {
  await ctx.answerCbQuery();
  await startAdvance(ctx);
});

/* ------------------------------------------------------------------ */
/* Return cash (no brand/category — just reduces the wallet balance)   */
/* ------------------------------------------------------------------ */

async function startReturn(ctx) {
  const user = await requireApproved(ctx);
  if (!user) return;
  await ctx.reply(
    [
      '↩️ How much cash are you returning?',
      'Just the number, then an optional note. Example: 50000 leftover from groceries',
      '',
      tagLine('return: '),
    ].join('\n'),
    FORCE_REPLY
  );
}

bot.command('return', startReturn);
bot.action('menu_return', async (ctx) => {
  await ctx.answerCbQuery();
  await startReturn(ctx);
});

/* ------------------------------------------------------------------ */
/* Reimbursements — pending claims + admin settlement                  */
/* ------------------------------------------------------------------ */

async function handleOwedCmd(ctx) {
  const user = await requireApproved(ctx);
  if (!user) return;
  const placeholder = await replyPlaceholder(ctx);
  try {
    const pending = await getPendingReimbursements();
    if (pending.length === 0) {
      return editPlaceholder(ctx, placeholder, 'No pending reimbursement claims — everyone is paid up. ✅');
    }

    let total = 0;
    const buttonRows = [];
    let msg = '🧾 Pending reimbursements\n\n';
    for (const r of pending) {
      const [id, , , nickname, brand, category, amount, description] = r;
      const amt = parseFloat(amount) || 0;
      total += amt;
      msg += `• ${id} — ${nickname}: ${formatMoney(amt)} (${brand} — ${category}${description ? `, ${description}` : ''})\n`;
      buttonRows.push([Markup.button.callback(`✅ Mark ${id} paid`, `paidback_${id}`)]);
    }
    msg += `\nTotal owed: ${formatMoney(total)}`;

    await editPlaceholder(ctx, placeholder, msg);
    if (user.isAdmin) {
      await ctx.reply('Tap to mark a claim as paid once you\'ve actually handed over the money:', Markup.inlineKeyboard(buttonRows));
    }
  } catch (err) {
    console.error('Failed to list reimbursements:', err);
    await editPlaceholder(ctx, placeholder, '⚠️ Could not read the sheet. Check the bot logs.');
  }
}
bot.command('owed', handleOwedCmd);
bot.action('menu_owed', async (ctx) => {
  await ctx.answerCbQuery();
  await handleOwedCmd(ctx);
});

bot.action(/^paidback_(.+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admins only', { show_alert: true });
  const id = ctx.match[1];
  try {
    const result = await settleReimbursement(id, telegramLabel(ctx));
    if (!result) {
      return ctx.answerCbQuery('Claim not found', { show_alert: true });
    }
    if (result.alreadySettled) {
      return ctx.answerCbQuery('Already marked as paid', { show_alert: true });
    }
    await ctx.answerCbQuery('Marked as paid');
    const [, , telegramId, nickname, brand, category, amount] = result.values;
    await ctx.editMessageText(`✅ ${id} — ${nickname}: ${formatMoney(parseFloat(amount) || 0)} (${brand} — ${category}) — paid by ${telegramLabel(ctx)}.`);
    try {
      await bot.telegram.sendMessage(telegramId, `✅ You've been paid back for reimbursement ${id}: ${formatMoney(parseFloat(amount) || 0)}.`);
    } catch (err) {
      console.error('Failed to notify reimbursed user:', err);
    }
  } catch (err) {
    console.error('Failed to settle reimbursement:', err);
    await ctx.answerCbQuery('Could not save that — check the bot logs', { show_alert: true });
  }
});

/* ------------------------------------------------------------------ */
/* Wallet / wallets / today / report                                   */
/* ------------------------------------------------------------------ */

async function handleWalletCmd(ctx) {
  const user = await requireApproved(ctx);
  if (!user) return;
  const placeholder = await replyPlaceholder(ctx);
  try {
    const balance = await getWalletBalance(user.telegramId);
    await editPlaceholder(ctx, placeholder, `👛 ${user.nickname}'s wallet: ${formatMoney(balance)}`);
  } catch (err) {
    console.error('Failed to read wallet balance:', err);
    await editPlaceholder(ctx, placeholder, '⚠️ Could not read the sheet. Check the bot logs.');
  }
}
bot.command('wallet', handleWalletCmd);
bot.action('menu_wallet', async (ctx) => {
  await ctx.answerCbQuery();
  await handleWalletCmd(ctx);
});

async function handleWalletsCmd(ctx) {
  const user = await requireApproved(ctx);
  if (!user) return;
  const placeholder = await replyPlaceholder(ctx);
  try {
    const balances = await getAllWalletBalances();
    const entries = Object.values(balances).filter((b) => Math.abs(b.balance) > 0.5);
    if (entries.length === 0) {
      return editPlaceholder(ctx, placeholder, 'No one is currently holding cash — all wallets are at zero. ✅');
    }

    entries.sort((a, b) => b.balance - a.balance);
    let msg = '👛 Wallet balances\n\n';
    let total = 0;
    const now = Date.now();
    for (const e of entries) {
      const hours = Math.round((now - new Date(e.lastActivity).getTime()) / (1000 * 60 * 60));
      msg += `• ${e.nickname || 'unknown'}: ${formatMoney(e.balance)} (last activity ${hours}h ago)\n`;
      total += e.balance;
    }
    msg += `\nTotal cash outstanding: ${formatMoney(total)}`;
    await editPlaceholder(ctx, placeholder, msg);
  } catch (err) {
    console.error('Failed to list wallets:', err);
    await editPlaceholder(ctx, placeholder, '⚠️ Could not read the sheet. Check the bot logs.');
  }
}
bot.command('wallets', handleWalletsCmd);
bot.action('menu_wallets', async (ctx) => {
  await ctx.answerCbQuery();
  await handleWalletsCmd(ctx);
});

async function handleTodayCmd(ctx) {
  const user = await requireApproved(ctx);
  if (!user) return;
  const placeholder = await replyPlaceholder(ctx);
  try {
    const rows = await getTodayExpenseRows();
    if (rows.length === 0) return editPlaceholder(ctx, placeholder, 'No expenses logged today.');

    let msg = "📅 Today's expenses\n\n";
    let total = 0;
    for (const [, brand, category, amount, description] of rows) {
      const amt = parseFloat(amount) || 0;
      msg += `• ${brand} — ${category}: ${formatMoney(amt)}${description ? ` (${description})` : ''}\n`;
      total += amt;
    }
    msg += `\nTotal: ${formatMoney(total)}`;
    await editPlaceholder(ctx, placeholder, msg);
  } catch (err) {
    console.error('Failed to fetch today rows:', err);
    await editPlaceholder(ctx, placeholder, '⚠️ Could not read the sheet. Check the bot logs.');
  }
}
bot.command('today', handleTodayCmd);
bot.action('menu_today', async (ctx) => {
  await ctx.answerCbQuery();
  await handleTodayCmd(ctx);
});

async function handleReportCmd(ctx) {
  const user = await requireApproved(ctx);
  if (!user) return;
  const placeholder = await replyPlaceholder(ctx);
  try {
    const [totals, budgets, walletBalances, pendingReimbursements] = await Promise.all([
      getMonthlySummary(),
      getBudgets(),
      getAllWalletBalances(),
      getPendingReimbursements(),
    ]);

    const monthLabel = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });
    let msg = `📊 ${monthLabel}\n\n`;

    const brandsWithData = new Set([...Object.keys(totals), ...Object.keys(budgets)]);
    if (brandsWithData.size === 0) {
      msg += 'No expenses logged this month yet.\n';
    } else {
      let grandTotal = 0;
      for (const brand of brandsWithData) {
        const categories = totals[brand] || {};
        const brandBudgets = budgets[brand] || {};
        const allCats = new Set([...Object.keys(categories), ...Object.keys(brandBudgets)]);
        if (allCats.size === 0) continue;

        let brandTotal = 0;
        msg += `${brand}\n`;
        for (const cat of allCats) {
          const spent = categories[cat] || 0;
          brandTotal += spent;
          const budget = brandBudgets[cat];
          if (budget) {
            const pct = Math.round((spent / budget) * 100);
            const flag = spent > budget ? ' ⚠️ over budget' : '';
            msg += `  • ${cat}: ${formatMoney(spent)} / ${formatMoney(budget)} (${pct}%)${flag}\n`;
          } else {
            msg += `  • ${cat}: ${formatMoney(spent)}\n`;
          }
        }
        msg += `  Subtotal: ${formatMoney(brandTotal)}\n\n`;
        grandTotal += brandTotal;
      }
      msg += `Grand total: ${formatMoney(grandTotal)}\n\n`;
    }

    const outstanding = Object.values(walletBalances).filter((b) => b.balance > 0.5);
    if (outstanding.length > 0) {
      const total = outstanding.reduce((s, b) => s + b.balance, 0);
      msg += `💵 Cash outstanding in wallets: ${outstanding.length} holder(s) totaling ${formatMoney(total)}. See /wallets.\n`;
    }

    if (pendingReimbursements.length > 0) {
      const total = pendingReimbursements.reduce((s, r) => s + (parseFloat(r[6]) || 0), 0);
      msg += `🧾 Reimbursements owed: ${pendingReimbursements.length} claim(s) totaling ${formatMoney(total)}. See /owed.`;
    }

    await editPlaceholder(ctx, placeholder, msg.trim());
  } catch (err) {
    console.error('Failed to build report:', err);
    await editPlaceholder(ctx, placeholder, '⚠️ Could not read the sheet. Check the bot logs.');
  }
}
bot.command('report', handleReportCmd);
bot.action('menu_report', async (ctx) => {
  await ctx.answerCbQuery();
  await handleReportCmd(ctx);
});

/* ------------------------------------------------------------------ */
/* Text handler — dispatches based on which prompt is being replied to  */
/* ------------------------------------------------------------------ */

bot.on('text', async (ctx, next) => {
  const replyTo = ctx.message.reply_to_message;
  if (!replyTo || !replyTo.text) return next();
  const text = ctx.message.text.trim();

  // 0) Registration nickname
  const registerRef = replyTo.text.match(/\[register: (.+?)\]/);
  if (registerRef) {
    const telegramId = registerRef[1];
    const nickname = text.trim();
    if (!nickname || nickname.length > 32) {
      return ctx.reply('Please send a short nickname (1-32 characters).');
    }
    try {
      if (await nicknameTaken(nickname)) {
        return ctx.reply(
          ['That nickname is already taken — try another one.', '', tagLine(`register: ${telegramId}`)].join('\n'),
          FORCE_REPLY
        );
      }
      await registerUser(telegramId, ctx.from.username ? `@${ctx.from.username}` : '', nickname);
      await ctx.reply(`Thanks, ${nickname}! Your request has been sent for approval — I'll let you know.`);
      if (process.env.ALERT_CHAT_ID) {
        await bot.telegram.sendMessage(
          process.env.ALERT_CHAT_ID,
          `🆕 New registration request\nNickname: ${nickname}\nTelegram: ${telegramLabel(ctx)} (ID ${telegramId})`,
          Markup.inlineKeyboard([
            [Markup.button.callback('✅ Approve', `appr_${telegramId}`), Markup.button.callback('🚫 Deny', `deny_${telegramId}`)],
          ])
        );
      }
    } catch (err) {
      console.error('Failed to register user:', err);
      await ctx.reply('⚠️ Could not save your registration. Please try /start again or check the bot logs.');
    }
    return;
  }

  const user = await requireApproved(ctx);
  if (!user) return; // requireApproved already sent a message

  // 1) Cash expense (drawn from wallet)
  const expRef = replyTo.text.match(/\[exp: (.+?)\|(.+?)\]/);
  if (expRef) {
    const [, brandId, category] = expRef;
    const brand = BRANDS.find((b) => b.id === brandId);
    if (!brand || !WALLET_CATEGORIES.includes(category)) {
      return ctx.reply(`That category isn't paid from the wallet — use /directpay for ${category || 'this'} instead.`);
    }
    const parsed = parseAmountAndText(text);
    if (!parsed) return ctx.reply('Please start with a number, e.g. "150000 taxi to warehouse"');

    try {
      const balance = await getWalletBalance(user.telegramId);
      if (parsed.amount > balance) {
        return ctx.reply(
          `🚫 Not enough in your wallet.\nYou have ${formatMoney(balance)}, this needs ${formatMoney(parsed.amount)}.\nTop up with /advance, or log it as /directpay if it wasn't paid from cash.`
        );
      }
      await Promise.all([
        appendWalletTransaction({
          telegramId: user.telegramId,
          nickname: user.nickname,
          type: 'Expense',
          brand: brand.label,
          category,
          amount: -parsed.amount,
          description: parsed.rest,
        }),
        appendExpense({
          brand: brand.label,
          category,
          amount: parsed.amount,
          description: parsed.rest,
          user: user.nickname,
          source: 'Wallet',
        }),
      ]);
      const newBalance = balance - parsed.amount;
      await ctx.reply(
        `✅ Logged: ${brand.label} — ${category}\n${formatMoney(parsed.amount)} — ${parsed.rest || '(no description)'}\n👛 Wallet balance: ${formatMoney(newBalance)}`
      );
    } catch (err) {
      console.error('Failed to log wallet expense:', err);
      await ctx.reply('⚠️ Could not save that to the sheet. Please try again or check the bot logs.');
    }
    return;
  }

  // 2) Direct payment (no wallet involved)
  const directRef = replyTo.text.match(/\[direct: (.+?)\|(.+?)\]/);
  if (directRef) {
    const [, brandId, category] = directRef;
    const brand = BRANDS.find((b) => b.id === brandId);
    if (!brand) return;
    const parsed = parseAmountAndText(text);
    if (!parsed) return ctx.reply('Please start with a number, e.g. "1500000 July office rent"');

    try {
      await appendExpense({
        brand: brand.label,
        category,
        amount: parsed.amount,
        description: parsed.rest,
        user: user.nickname,
        source: 'Direct',
      });
      await ctx.reply(`✅ Logged: ${brand.label} — ${category}\n${formatMoney(parsed.amount)} — ${parsed.rest || '(no description)'}`);
    } catch (err) {
      console.error('Failed to log direct payment:', err);
      await ctx.reply('⚠️ Could not save that to the sheet. Please try again or check the bot logs.');
    }
    return;
  }

  // 2b) Reimbursement (paid from the employee's own pocket, owed back)
  const reimbRef = replyTo.text.match(/\[reimb: (.+?)\|(.+?)\]/);
  if (reimbRef) {
    const [, brandId, category] = reimbRef;
    const brand = BRANDS.find((b) => b.id === brandId);
    if (!brand) return;
    const parsed = parseAmountAndText(text);
    if (!parsed) return ctx.reply('Please start with a number, e.g. "80000 printer paper, paid cash"');

    try {
      const [id] = await Promise.all([
        appendReimbursement({
          telegramId: user.telegramId,
          nickname: user.nickname,
          brand: brand.label,
          category,
          amount: parsed.amount,
          description: parsed.rest,
        }),
        appendExpense({
          brand: brand.label,
          category,
          amount: parsed.amount,
          description: parsed.rest,
          user: user.nickname,
          source: 'Reimbursement',
        }),
      ]);
      await ctx.reply(
        `✅ Reimbursement claim ${id} filed: ${formatMoney(parsed.amount)} for ${brand.label} — ${category}\n${parsed.rest || ''}\n\nYou'll be notified once you're paid back.`
      );
      if (process.env.ALERT_CHAT_ID) {
        await bot.telegram.sendMessage(
          process.env.ALERT_CHAT_ID,
          `🧾 New reimbursement claim ${id}\n${user.nickname}: ${formatMoney(parsed.amount)} — ${brand.label} — ${category}${parsed.rest ? `\n${parsed.rest}` : ''}`,
          Markup.inlineKeyboard([[Markup.button.callback('✅ Mark as paid', `paidback_${id}`)]])
        );
      }
    } catch (err) {
      console.error('Failed to log reimbursement:', err);
      await ctx.reply('⚠️ Could not save that to the sheet. Please try again or check the bot logs.');
    }
    return;
  }

  // 3) Top up wallet
  const topupRef = replyTo.text.match(/\[advtopup: \]/);
  if (topupRef) {
    const parsed = parseAmountAndText(text);
    if (!parsed) return ctx.reply('Please start with a number, e.g. "500000 weekly float"');

    try {
      // Read the balance BEFORE appending, then add locally — there's no
      // ordering guarantee between two concurrent calls, so running the read
      // and the write at the same time (as this used to) risks the read
      // landing after the write and double-counting the top-up.
      const balanceBefore = await getWalletBalance(user.telegramId);
      await appendWalletTransaction({
        telegramId: user.telegramId,
        nickname: user.nickname,
        type: 'TopUp',
        brand: '',
        category: '',
        amount: parsed.amount,
        description: parsed.rest,
      });
      const newBalance = balanceBefore + parsed.amount;
      await ctx.reply(`✅ Wallet topped up: ${formatMoney(parsed.amount)}\n👛 New balance: ${formatMoney(newBalance)}`);
    } catch (err) {
      console.error('Failed to top up wallet:', err);
      await ctx.reply('⚠️ Could not save that to the sheet. Please try again or check the bot logs.');
    }
    return;
  }

  // 4) Return cash
  const returnRef = replyTo.text.match(/\[return: \]/);
  if (returnRef) {
    const parsed = parseAmountAndText(text);
    if (!parsed) return ctx.reply('Please start with a number, e.g. "50000 leftover from groceries"');

    try {
      const balance = await getWalletBalance(user.telegramId);
      if (parsed.amount > balance) {
        return ctx.reply(`You only have ${formatMoney(balance)} in your wallet — can't return more than that.`);
      }
      await appendWalletTransaction({
        telegramId: user.telegramId,
        nickname: user.nickname,
        type: 'Return',
        brand: '',
        category: '',
        amount: -parsed.amount,
        description: parsed.rest,
      });
      const newBalance = balance - parsed.amount;
      await ctx.reply(`✅ Returned ${formatMoney(parsed.amount)}.\n👛 New balance: ${formatMoney(newBalance)}`);
    } catch (err) {
      console.error('Failed to log return:', err);
      await ctx.reply('⚠️ Could not save that to the sheet. Please try again or check the bot logs.');
    }
    return;
  }

  return next();
});

/* ------------------------------------------------------------------ */
/* Command menu (Telegram's native "/" autocomplete)                    */
/* ------------------------------------------------------------------ */

bot.telegram
  .setMyCommands([
    { command: 'start', description: 'Get started / show menu' },
    { command: 'expense', description: 'Log a cash expense from your wallet' },
    { command: 'directpay', description: 'Log a direct payment (rent, salary, bank transfer)' },
    { command: 'advance', description: 'Top up your cash wallet' },
    { command: 'return', description: 'Return unspent cash to your wallet balance' },
    { command: 'reimburse', description: 'Claim back money you paid from your own pocket' },
    { command: 'owed', description: 'See pending reimbursement claims' },
    { command: 'wallet', description: 'Check your wallet balance' },
    { command: 'wallets', description: "See everyone's wallet balances" },
    { command: 'today', description: "Today's expenses" },
    { command: 'report', description: 'Monthly report' },
    { command: 'cancel', description: 'Cancel whatever you were doing' },
    { command: 'getid', description: "Show this chat's Telegram ID" },
  ])
  .catch((err) => console.error('Failed to set command menu:', err));

module.exports = bot;
