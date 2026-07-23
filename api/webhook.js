const bot = require('../lib/bot');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(200).send('Expense bot webhook is running.');
    return;
  }

  try {
    await bot.handleUpdate(req.body, res);
  } catch (err) {
    console.error('Error handling update:', err);
  }

  if (!res.headersSent) {
    res.status(200).send('OK');
  }
};
