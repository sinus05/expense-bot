const { Telegraf, Markup } = require('telegraf');
const { BRANDS, CATEGORIES } = require('./categories');
const {
  appendExpense,
  getTodayExpenseRows,
  appendAdvance,
  findAdvanceById,
  settleAdvance,
  getOpenAdvances,
  getSettledAdvancesThisMonth,
  getBudgets,
  getMonthlySummary,
} = require('./sheets');

const bot = new Telegraf(process.env.BOT_TOKEN);
const TOLERANCE = parseFloat(process.env.DISCREPANCY_TOLERANCE) || 2000;

function formatMoney(n) {
  return Math.round(n).toLocaleString('en-US') + ' UZS';
}

function userLabel(ctx) {
  return ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
}

function categoryKeyboard(prefix) {
  const buttons = CATEGORIES.map((c) => Markup.button.callback(c, `${prefix}${c}`));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  return Markup.inlineKeyboard(rows);
}

// A prompt's routing info, plain text on its own line with a note that it's
// not meant to be typed — this is what the bot reads back to know which
// question it asked, not something the person needs to interact with.
function tagLine(value) {
  return `(the code below is just for the bot — ignore it)\n[${value}]`;
}

const FORCE_REPLY = { reply_markup: { force_reply: true, selective: true } };

// Parses "amount rest-of-text" — one number, then free text after. Used for expense/advance entry.
function parseAmountAndText(text) {
  const m = text.trim().match(/^([\d.,]+)\s*(.*)$/);
  if (!m) return null;
  const amount = parseFloat(m[1].replace(/,/g, ''));
  if (!amount || Number.isNaN(amount)) return null;
  return { amount, rest: m[2] || '' };
}

// Parses a single number from a reply — forgiving of stray words/units around it.
function parseSingleAmount(text) {
  const m = text.trim().match(/([\d.,]+)/);
  if (!m) return null;
  const amount = parseFloat(m[1].replace(/,/g, ''));
  if (Number.isNaN(amount)) return null;
  return amount;
}

/* ------------------------------------------------------------------ */
/* Help                                                                 */
/* ------------------------------------------------------------------ */

bot.start((ctx) => {
  ctx.reply(
    [
      'Expense & Cash Advance Bot 📒',
      '',
      'Direct expenses (no cash handed out first):',
      '/expense — log one',
      '',
      'Cash advances (money given in advance to go buy something):',
      '/advance — record cash handed out',
      '/settle <ID> — reconcile it (I\'ll ask you step by step)',
      '/open — list advances not yet settled',
      '/receipt <ID> — re-show a saved receipt photo/PDF',
      '',
      'Reports:',
      '/today — today\'s activity',
      '/report — this month: spend vs budget, outstanding cash, discrepancies',
      '',
      '/getid — show this chat\'s ID (for setting up overdue alerts)',
    ].join('\n')
  );
});

bot.command('getid', (ctx) => {
  ctx.reply(`This chat's ID is: ${ctx.chat.id}`);
});

/* ------------------------------------------------------------------ */
/* Direct expense flow                                                  */
/* ------------------------------------------------------------------ */

bot.command('expense', (ctx) => {
  ctx.reply(
    'Which brand is this expense for?',
    Markup.inlineKeyboard(BRANDS.map((b) => Markup.button.callback(b.label, `brand_${b.id}`)))
  );
});

bot.action(/^brand_(.+)$/, async (ctx) => {
  const brandId = ctx.match[1];
  const brand = BRANDS.find((b) => b.id === brandId);
  if (!brand) return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  await ctx.editMessageText(`${brand.label} — choose a category:`, categoryKeyboard(`cat_${brandId}__`));
});

bot.action(/^cat_(.+)__(.+)$/, async (ctx) => {
  const [, brandId, category] = ctx.match;
  const brand = BRANDS.find((b) => b.id === brandId);
  if (!brand) return ctx.answerCbQuery();

  await ctx.answerCbQuery();
  await ctx.reply(
    [
      `📝 ${brand.label} — ${category}`,
      'Type the amount, then a short description.',
      'Example: 1500000 July office rent',
      '',
      tagLine(`ref: ${brandId}|${category}`),
    ].join('\n'),
    FORCE_REPLY
  );
});

/* ------------------------------------------------------------------ */
/* Cash advance flow                                                    */
/* ------------------------------------------------------------------ */

bot.command('advance', (ctx) => {
  ctx.reply(
    'Which brand is this cash advance for?',
    Markup.inlineKeyboard(BRANDS.map((b) => Markup.button.callback(b.label, `advbrand_${b.id}`)))
  );
});

bot.action(/^advbrand_(.+)$/, async (ctx) => {
  const brandId = ctx.match[1];
  const brand = BRANDS.find((b) => b.id === brandId);
  if (!brand) return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  await ctx.editMessageText(`${brand.label} — what's the cash for?`, categoryKeyboard(`advcat_${brandId}__`));
});

bot.action(/^advcat_(.+)__(.+)$/, async (ctx) => {
  const [, brandId, category] = ctx.match;
  const brand = BRANDS.find((b) => b.id === brandId);
  if (!brand) return ctx.answerCbQuery();

  await ctx.answerCbQuery();
  await ctx.reply(
    [
      `💵 Cash advance — ${brand.label} — ${category}`,
      'Type the amount you\'re handing over, then who it\'s for.',
      'Example: 500000 weekly groceries, given to Aziz',
      '',
      tagLine(`advref: ${brandId}|${category}`),
    ].join('\n'),
    FORCE_REPLY
  );
});

bot.command('open', async (ctx) => {
  try {
    const rows = await getOpenAdvances();
    if (rows.length === 0) return ctx.reply('No open cash advances right now — everything is settled. ✅');

    let msg = '💵 Open cash advances (not yet settled)\n\n';
    let total = 0;
    const now = Date.now();
    for (const r of rows) {
      const [id, issuedAt, brand, category, amount, purpose, issuedTo] = r;
      const amt = parseFloat(amount) || 0;
      const hours = Math.round((now - new Date(issuedAt).getTime()) / (1000 * 60 * 60));
      const overdueFlag = hours >= 24 ? ' ⚠️ overdue' : '';
      msg += `• ${id} — ${brand} — ${category}: ${formatMoney(amt)}\n  Given to ${issuedTo || 'unknown'}, ${hours}h ago${overdueFlag}${purpose ? ` — ${purpose}` : ''}\n`;
      total += amt;
    }
    msg += `\nTotal outstanding: ${formatMoney(total)}\nSettle any of these with /settle <ID>`;
    await ctx.reply(msg);
  } catch (err) {
    console.error('Failed to list open advances:', err);
    await ctx.reply('⚠️ Could not read the sheet. Check the bot logs.');
  }
});

/* ------------------------------------------------------------------ */
/* Settlement — guided, one question at a time (buttons, then single   */
/* numbers only — no format or keyword to remember)                    */
/* ------------------------------------------------------------------ */

bot.command('settle', async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  const id = parts[1];
  if (!id) return ctx.reply('Usage: /settle <ID>  (find the ID with /open)');

  try {
    const found = await findAdvanceById(id);
    if (!found) return ctx.reply(`No advance found with ID ${id.toUpperCase()}. Check /open for valid IDs.`);
    if ((found.values[7] || '') !== 'Open') {
      return ctx.reply(`${id.toUpperCase()} is already ${found.values[7]}, not open.`);
    }

    const idUpper = id.toUpperCase();
    const [, , brand, category, amount, purpose, issuedTo] = found.values;
    await ctx.reply(
      [
        `📎 Settling ${idUpper} — ${brand} — ${category}`,
        `Issued: ${formatMoney(parseFloat(amount))} to ${issuedTo}${purpose ? ` (${purpose})` : ''}`,
        '',
        'Do you have a receipt for this?',
      ].join('\n'),
      Markup.inlineKeyboard([
        [Markup.button.callback('📷 Yes, I have a receipt', `hasreceipt_${idUpper}`)],
        [Markup.button.callback('🚫 No receipt', `noreceipt_${idUpper}`)],
      ])
    );
  } catch (err) {
    console.error('Failed to start settlement:', err);
    await ctx.reply('⚠️ Could not read the sheet. Check the bot logs.');
  }
});

bot.action(/^hasreceipt_(.+)$/, async (ctx) => {
  const id = ctx.match[1];
  await ctx.answerCbQuery();
  await ctx.reply(
    [
      `📎 ${id} — send the receipt now`,
      'Just the photo or a PDF file — no caption needed.',
      '',
      tagLine(`settlereceipt: ${id}`),
    ].join('\n'),
    FORCE_REPLY
  );
});

bot.action(/^noreceipt_(.+)$/, async (ctx) => {
  const id = ctx.match[1];
  await ctx.answerCbQuery();
  await ctx.reply(
    [
      `💵 ${id} — how much was actually spent?`,
      'Just the number. Example: 480000',
      '',
      tagLine(`settlespent: ${id}|none|`),
    ].join('\n'),
    FORCE_REPLY
  );
});

bot.command('receipt', async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  const id = parts[1];
  if (!id) return ctx.reply('Usage: /receipt <ID>');

  try {
    const found = await findAdvanceById(id);
    if (!found) return ctx.reply(`No advance found with ID ${id.toUpperCase()}.`);
    const fileId = found.values[12];
    const type = found.values[13];
    if (!fileId) return ctx.reply(`No receipt was saved for ${id.toUpperCase()}.`);

    if (type === 'document') {
      await ctx.replyWithDocument(fileId, { caption: `Receipt for ${id.toUpperCase()}` });
    } else {
      await ctx.replyWithPhoto(fileId, { caption: `Receipt for ${id.toUpperCase()}` });
    }
  } catch (err) {
    console.error('Failed to fetch receipt:', err);
    await ctx.reply('⚠️ Could not retrieve that receipt. It may have been sent too long ago for Telegram to still serve it — check the bot logs.');
  }
});

async function finishSettlement(ctx, id, amountSpent, changeReturned, receiptFileId, receiptType) {
  try {
    const result = await settleAdvance(id, {
      amountSpent,
      changeReturned,
      receiptFileId,
      receiptType,
      note: receiptType === 'none' ? 'No receipt provided' : '',
      tolerance: TOLERANCE,
    });

    if (!result) return ctx.reply(`No advance found with ID ${id}.`);

    const { discrepancy, status, brand, category, amountIssued } = result;
    let msg = `✅ ${id} settled — ${brand} — ${category}\n`;
    msg += `Issued: ${formatMoney(amountIssued)} | Spent: ${formatMoney(amountSpent)} | Change returned: ${formatMoney(changeReturned)}\n`;

    if (status === 'Settled-Discrepancy') {
      if (discrepancy > 0) {
        msg += `🚩 Short by ${formatMoney(discrepancy)} — this amount is unaccounted for.`;
      } else {
        msg += `🚩 Over by ${formatMoney(-discrepancy)} — spent/returned more than was issued.`;
      }
    } else {
      msg += '✔️ Fully accounted for.';
    }
    if (receiptType === 'none') msg += '\n(No receipt was provided for this settlement.)';

    await ctx.reply(msg);
  } catch (err) {
    console.error('Failed to settle advance:', err);
    await ctx.reply('⚠️ Could not save the settlement. Please try again or check the bot logs.');
  }
}

// Step: receipt photo attached → save it, then ask how much was spent.
bot.on('photo', async (ctx) => {
  const replyTo = ctx.message.reply_to_message;
  if (!replyTo || !replyTo.text) return;
  const m = replyTo.text.match(/\[settlereceipt: (.+?)\]/);
  if (!m) return;

  const id = m[1];
  const photos = ctx.message.photo;
  const fileId = photos[photos.length - 1].file_id; // largest size

  try {
    await ctx.reply(
      [
        '✅ Receipt saved.',
        '',
        `💵 ${id} — how much was actually spent?`,
        'Just the number. Example: 480000',
        '',
        tagLine(`settlespent: ${id}|photo|${fileId}`),
      ].join('\n'),
      FORCE_REPLY
    );
  } catch (err) {
    console.error('Failed to acknowledge receipt photo:', err);
    await ctx.reply('⚠️ Something went wrong saving that. Please try /settle again.');
  }
});

// Step: receipt PDF attached → save it, then ask how much was spent.
bot.on('document', async (ctx) => {
  const replyTo = ctx.message.reply_to_message;
  if (!replyTo || !replyTo.text) return;
  const m = replyTo.text.match(/\[settlereceipt: (.+?)\]/);
  if (!m) return;

  const id = m[1];
  const fileId = ctx.message.document.file_id;

  try {
    await ctx.reply(
      [
        '✅ Receipt saved.',
        '',
        `💵 ${id} — how much was actually spent?`,
        'Just the number. Example: 480000',
        '',
        tagLine(`settlespent: ${id}|document|${fileId}`),
      ].join('\n'),
      FORCE_REPLY
    );
  } catch (err) {
    console.error('Failed to acknowledge receipt document:', err);
    await ctx.reply('⚠️ Something went wrong saving that. Please try /settle again.');
  }
});

/* ------------------------------------------------------------------ */
/* Text handler — dispatches based on which prompt is being replied to  */
/* ------------------------------------------------------------------ */

bot.on('text', async (ctx) => {
  const replyTo = ctx.message.reply_to_message;
  if (!replyTo || !replyTo.text) return;
  const text = ctx.message.text.trim();

  // 1) Direct expense
  const expenseRef = replyTo.text.match(/\[ref: (.+?)\|(.+?)\]/);
  if (expenseRef) {
    const [, brandId, category] = expenseRef;
    const brand = BRANDS.find((b) => b.id === brandId);
    if (!brand) return;
    const parsed = parseAmountAndText(text);
    if (!parsed) return ctx.reply('Please start with a number, e.g. "1500000 July office rent"');

    try {
      await appendExpense({ brand: brand.label, category, amount: parsed.amount, description: parsed.rest, user: userLabel(ctx) });
      await ctx.reply(`✅ Logged: ${brand.label} — ${category}\n${formatMoney(parsed.amount)} — ${parsed.rest || '(no description)'}`);
    } catch (err) {
      console.error('Failed to append expense:', err);
      await ctx.reply('⚠️ Could not save that to the sheet. Please try again or check the bot logs.');
    }
    return;
  }

  // 2) Cash advance being issued
  const advRef = replyTo.text.match(/\[advref: (.+?)\|(.+?)\]/);
  if (advRef) {
    const [, brandId, category] = advRef;
    const brand = BRANDS.find((b) => b.id === brandId);
    if (!brand) return;
    const parsed = parseAmountAndText(text);
    if (!parsed) return ctx.reply('Please start with a number, e.g. "500000 weekly groceries, given to Aziz"');

    try {
      const id = await appendAdvance({ brand: brand.label, category, amount: parsed.amount, purpose: parsed.rest, issuedTo: userLabel(ctx) });
      await ctx.reply(
        `✅ Advance ${id} recorded: ${formatMoney(parsed.amount)} for ${brand.label} — ${category}\n${parsed.rest || ''}\n\nWhen the shopping is done, settle it with:\n/settle ${id}`
      );
    } catch (err) {
      console.error('Failed to append advance:', err);
      await ctx.reply('⚠️ Could not save that to the sheet. Please try again or check the bot logs.');
    }
    return;
  }

  // 3) "How much was spent?" step (either receipt already attached, or none)
  const spentRef = replyTo.text.match(/\[settlespent: (.+?)\|(.+?)\|(.*?)\]/);
  if (spentRef) {
    const [, id, receiptType, fileId] = spentRef;
    const amountSpent = parseSingleAmount(text);
    if (amountSpent === null) return ctx.reply('Please reply with just the number, e.g. "480000"');

    await ctx.reply(
      [
        `💵 ${id} — how much change was returned?`,
        'Just the number — type 0 if none.',
        '',
        tagLine(`settlechange: ${id}|${receiptType}|${fileId}|${amountSpent}`),
      ].join('\n'),
      FORCE_REPLY
    );
    return;
  }

  // 4) "How much change was returned?" step → finalize
  const changeRef = replyTo.text.match(/\[settlechange: (.+?)\|(.+?)\|(.*?)\|(.+?)\]/);
  if (changeRef) {
    const [, id, receiptType, fileId, amountSpentStr] = changeRef;
    const changeReturned = parseSingleAmount(text);
    if (changeReturned === null) return ctx.reply('Please reply with just the number — type "0" if no change was returned.');

    const amountSpent = parseFloat(amountSpentStr);
    await finishSettlement(ctx, id, amountSpent, changeReturned, fileId, receiptType);
  }
});

/* ------------------------------------------------------------------ */
/* Reports                                                              */
/* ------------------------------------------------------------------ */

bot.command('report', async (ctx) => {
  try {
    const [totals, budgets, openAdvances, settledThisMonth] = await Promise.all([
      getMonthlySummary(),
      getBudgets(),
      getOpenAdvances(),
      getSettledAdvancesThisMonth(),
    ]);

    const monthLabel = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });
    let msg = `📊 ${monthLabel}\n\n`;

    const brandsWithData = new Set([...Object.keys(totals), ...Object.keys(budgets)]);
    if (brandsWithData.size === 0) {
      msg += 'No expenses or advances logged this month yet.\n';
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
      msg += `Grand total (confirmed spend): ${formatMoney(grandTotal)}\n\n`;
    }

    // Outstanding cash
    if (openAdvances.length > 0) {
      const total = openAdvances.reduce((s, r) => s + (parseFloat(r[4]) || 0), 0);
      msg += `💵 Outstanding cash: ${openAdvances.length} advance(s) totaling ${formatMoney(total)} not yet settled. See /open.\n\n`;
    }

    // Discrepancies
    const discrepancies = settledThisMonth.filter((r) => (r[7] || '') === 'Settled-Discrepancy');
    if (discrepancies.length > 0) {
      msg += `🚩 Discrepancies this month:\n`;
      for (const r of discrepancies) {
        const [id, , brand, category, , , issuedTo] = r;
        const discrepancy = parseFloat(r[11]) || 0;
        const direction = discrepancy > 0 ? `short by ${formatMoney(discrepancy)}` : `over by ${formatMoney(-discrepancy)}`;
        msg += `  • ${id} — ${brand}/${category} — ${issuedTo}: ${direction}\n`;
      }
      msg += '\n';
    }

    // Receiptless settlements pattern
    const noReceipt = settledThisMonth.filter((r) => (r[13] || '') === 'none');
    if (noReceipt.length > 0) {
      const byPerson = {};
      for (const r of noReceipt) {
        const issuedTo = r[6] || 'unknown';
        byPerson[issuedTo] = (byPerson[issuedTo] || 0) + 1;
      }
      msg += `ℹ️ Settlements with no receipt this month: ${noReceipt.length} (${Object.entries(byPerson).map(([p, c]) => `${p}: ${c}`).join(', ')})`;
    }

    await ctx.reply(msg.trim());
  } catch (err) {
    console.error('Failed to build report:', err);
    await ctx.reply('⚠️ Could not read the sheet. Check the bot logs.');
  }
});

bot.command('today', async (ctx) => {
  try {
    const rows = await getTodayExpenseRows();
    if (rows.length === 0) return ctx.reply("No direct expenses logged today. Check /open for outstanding cash advances.");

    let msg = "📅 Today's expenses\n\n";
    let total = 0;
    for (const [, brand, category, amount, description] of rows) {
      const amt = parseFloat(amount) || 0;
      msg += `• ${brand} — ${category}: ${formatMoney(amt)}${description ? ` (${description})` : ''}\n`;
      total += amt;
    }
    msg += `\nTotal: ${formatMoney(total)}`;
    await ctx.reply(msg);
  } catch (err) {
    console.error('Failed to fetch today rows:', err);
    await ctx.reply('⚠️ Could not read the sheet. Check the bot logs.');
  }
});

module.exports = bot;
