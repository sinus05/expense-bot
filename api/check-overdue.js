const bot = require('../lib/bot');
const { getOverdueAdvances, markAdvanceFlagged } = require('../lib/sheets');

const OVERDUE_HOURS = parseFloat(process.env.OVERDUE_HOURS) || 24;
const REFLAG_HOURS = parseFloat(process.env.REFLAG_HOURS) || 24;

function formatMoney(n) {
  return Math.round(n).toLocaleString('en-US') + ' UZS';
}

module.exports = async (req, res) => {
  // Vercel sends this header automatically for scheduled cron invocations.
  const authHeader = req.headers.authorization || '';
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).send('Unauthorized');
    return;
  }

  try {
    const overdue = await getOverdueAdvances(OVERDUE_HOURS, REFLAG_HOURS);

    if (overdue.length > 0 && process.env.ALERT_CHAT_ID) {
      let msg = `⚠️ ${overdue.length} cash advance(s) still open after ${OVERDUE_HOURS}h:\n\n`;
      for (const { values, hoursOpen } of overdue) {
        const [id, , brand, category, amount, purpose, issuedTo] = values;
        msg += `• ${id} — ${brand}/${category}: ${formatMoney(parseFloat(amount))} to ${issuedTo}, open ${Math.round(hoursOpen)}h${purpose ? ` — ${purpose}` : ''}\n`;
      }
      msg += `\nSettle with /settle <ID>`;
      await bot.telegram.sendMessage(process.env.ALERT_CHAT_ID, msg);

      for (const { rowNumber, values } of overdue) {
        await markAdvanceFlagged(rowNumber, values);
      }
    }

    res.status(200).json({ ok: true, flagged: overdue.length });
  } catch (err) {
    console.error('check-overdue failed:', err);
    res.status(500).json({ ok: false, error: String(err) });
  }
};
