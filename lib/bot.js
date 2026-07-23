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

// Parses "amount rest-of-text" — used for expense/advance entry.
function parseAmountAndText(text) {
  const m = text.trim().match(/^([\d.,]+)\s*(.*)$/);
  if (!m) return null;
  const amount = parseFloat(m[1].replace(/,/g, ''));
  if (!amount || Number.isNaN(amount)) return null;
  return { amount, rest: m[2] || '' };
}

// Parses "amount amount2" (settlement: amount spent, change returned). Second is optional (defaults 0).
// A leading "no receipt" is stripped and remembered.
function parseSettlement(text) {
  let t = text.trim();
  let noReceiptNoted = false;
  const noReceiptMatch = t.match(/^no receipt\s*/i);
  if (noReceiptMatch) {
    noReceiptNoted = true;
    t = t.slice(noReceiptMatch[0].length);
  }
  const m = t.match(/^([\d.,]+)(?:\s+([\d.,]+))?/);
  if (!m) return null;
  const amountSpent = parseFloat(m[1].replace(/,/g, ''));
  const changeReturned = m[2] ? parseFloat(m[2].replace(/,/g, '')) : 0;
  if (Number.isNaN(amountSpent)) return null;
  return { amountSpent, changeReturned: Number.isNaN(changeReturned) ? 0 : changeReturned, noReceiptNoted };
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
      '/settle <ID> — reconcile it against receipts/spend',
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
/* Direct expense flow (unchanged behavior)                            */
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
      'Reply to THIS message with the amount and a short description.',
      'Example: 1500000 July office rent',
      '',
      `[ref: ${brandId}|${category}]`,
    ].join('\n'),
    { reply_markup: { force_reply: true, selective: true } }
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
      'Reply to THIS message with the amount being handed over and who/what it\'s for.',
      'Example: 500000 weekly groceries, given to Aziz',
      '',
      `[advref: ${brandId}|${category}]`,
    ].join('\n'),
    { reply_markup: { force_reply: true, selective: true } }
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

    const [, , brand, category, amount, purpose, issuedTo] = found.values;
    await ctx.reply(
      [
        `📎 Settling ${id.toUpperCase()} — ${brand} — ${category}`,
        `Issued: ${formatMoney(parseFloat(amount))} to ${issuedTo}${purpose ? ` (${purpose})` : ''}`,
        '',
        'If you have a receipt: reply to THIS message attaching the photo or PDF, with a caption:',
        'amount_spent change_returned',
        'e.g. 480000 20000',
        '',
        'If there is no receipt: reply to THIS message with:',
        'no receipt amount_spent change_returned',
        '',
        `[settleref: ${id.toUpperCase()}]`,
      ].join('\n'),
      { reply_markup: { force_reply: true, selective: true } }
    );
  } catch (err) {
    console.error('Failed to start settlement:', err);
    await ctx.reply('⚠️ Could not read the sheet. Check the bot logs.');
  }
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

async function finishSettlement(ctx, id, parsed, receiptFileId, receiptType) {
  try {
    const note = parsed.noReceiptNoted ? 'No receipt provided' : '';
    const result = await settleAdvance(id, {
      amountSpent: parsed.amountSpent,
      changeReturned: parsed.changeReturned,
      receiptFileId,
      receiptType,
      note,
      tolerance: TOLERANCE,
    });

    if (!result) return ctx.reply(`No advance found with ID ${id}.`);

    const { discrepancy, status, brand, category, amountIssued } = result;
    let msg = `✅ ${id} settled — ${brand} — ${category}\n`;
    msg += `Issued: ${formatMoney(amountIssued)} | Spent: ${formatMoney(parsed.amountSpent)} | Change returned: ${formatMoney(parsed.changeReturned)}\n`;

    if (status === 'Settled-Discrepancy') {
      if (discrepancy > 0) {
        msg += `🚩 Short by ${formatMoney(discrepancy)} — this amount is unaccounted for.`;
      } else {
        msg += `🚩 Over by ${formatMoney(-discrepancy)} — spent/returned more than was issued.`;
      }
    } else {
      msg += '✔️ Fully accounted for.';
    }
    if (parsed.noReceiptNoted) msg += '\n(No receipt was provided for this settlement.)';

    await ctx.reply(msg);
  } catch (err) {
    console.error('Failed to settle advance:', err);
    await ctx.reply('⚠️ Could not save the settlement. Please try again or check the bot logs.');
  }
}

// Photo reply = receipt photo attached to a /settle prompt.
bot.on('photo', async (ctx) => {
  const replyTo = ctx.message.reply_to_message;
  if (!replyTo || !replyTo.text) return;
  const m = replyTo.text.match(/\[settleref: (.+?)\]/);
  if (!m) return;

  const id = m[1];
  const caption = ctx.message.caption || '';
  const parsed = parseSettlement(caption);
  if (!parsed) {
    return ctx.reply('Please add a caption to the photo: amount_spent change_returned, e.g. "480000 20000"');
  }

  const photos = ctx.message.photo;
  const fileId = photos[photos.length - 1].file_id; // largest size
  await finishSettlement(ctx, id, parsed, fileId, 'photo');
});

// Document reply = receipt PDF attached to a /settle prompt.
bot.on('document', async (ctx) => {
  const replyTo = ctx.message.reply_to_message;
  if (!replyTo || !replyTo.text) return;
  const m = replyTo.text.match(/\[settleref: (.+?)\]/);
  if (!m) return;

  const id = m[1];
  const caption = ctx.message.caption || '';
  const parsed = parseSettlement(caption);
  if (!parsed) {
    return ctx.reply('Please add a caption to the file: amount_spent change_returned, e.g. "480000 20000"');
  }

  const fileId = ctx.message.document.file_id;
  await finishSettlement(ctx, id, parsed, fileId, 'document');
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

  // 3) Settlement with no receipt (plain text reply, no photo/document)
  const settleRef = replyTo.text.match(/\[settleref: (.+?)\]/);
  if (settleRef) {
    const id = settleRef[1];
    const parsed = parseSettlement(text);
    if (!parsed) {
      return ctx.reply('Please reply with: amount_spent change_returned (e.g. "480000 20000"), or attach a receipt photo/PDF instead.');
    }
    await finishSettlement(ctx, id, parsed, '', 'none');
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
