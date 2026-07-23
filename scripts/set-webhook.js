// Usage:
//   BOT_TOKEN=xxxx VERCEL_URL=https://your-app.vercel.app node scripts/set-webhook.js
//
// Or just run the equivalent curl command shown in the README — this script
// does the same thing.

const https = require('https');

const token = process.env.BOT_TOKEN;
const url = process.env.VERCEL_URL;

if (!token || !url) {
  console.error('Set BOT_TOKEN and VERCEL_URL environment variables first.');
  process.exit(1);
}

const webhookUrl = `${url.replace(/\/$/, '')}/api/webhook`;
const apiUrl = `https://api.telegram.org/bot${token}/setWebhook?url=${encodeURIComponent(webhookUrl)}`;

https.get(apiUrl, (res) => {
  let data = '';
  res.on('data', (chunk) => (data += chunk));
  res.on('end', () => {
    console.log(data);
  });
});
