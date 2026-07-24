const bot = require('../lib/bot');
const { getStaleWallets, markUserFlagged } = require('../lib/sheets');

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
    const stale = await getStaleWallets(OVERDUE_HOURS, REFLAG_HOURS);

    if (stale.length > 0 && process.env.ALERT_CHAT_ID) {
      let msg = `⚠️ ${stale.length} wallet(s) still holding cash after ${OVERDUE_HOURS}h:\n\n`;
      for (const s of stale) {
        msg += `• ${s.nickname || 'unknown'}: ${formatMoney(s.balance)}, held ${Math.round(s.hoursOpen)}h\n`;
      }
      msg += `\nSettle up with /return, or check /wallets.`;
      await bot.telegram.sendMessage(process.env.ALERT_CHAT_ID, msg);

      for (const s of stale) {
        await markUserFlagged(s.telegramId);
      }
    }

    res.status(200).json({ ok: true, flagged: stale.length });
  } catch (err) {
    console.error('check-overdue failed:', err);
    res.status(500).json({ ok: false, error: String(err) });
  }
};
