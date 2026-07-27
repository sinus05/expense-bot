// One-off migration script: creates the Wallet, Users, and Reimbursements
// tabs (with headers) and adds the Source column to Expenses if missing.
// Safe to re-run — it only creates/writes what's missing.
const { sheets } = require('@googleapis/sheets');
const { GoogleAuth } = require('google-auth-library');

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const EXPENSES_TAB = process.env.GOOGLE_SHEET_TAB || 'Expenses';

async function main() {
  if (!SHEET_ID || !process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    throw new Error('GOOGLE_SHEET_ID / GOOGLE_SERVICE_ACCOUNT_JSON not set in the environment.');
  }

  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const authClient = await auth.getClient();
  const sheetsClient = sheets({ version: 'v4', auth: authClient });

  const meta = await sheetsClient.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const existingTitles = meta.data.sheets.map((s) => s.properties.title);
  console.log('Existing tabs:', existingTitles.join(', '));

  const tabsToCreate = ['Wallet', 'Users', 'Reimbursements'].filter((t) => !existingTitles.includes(t));
  if (tabsToCreate.length > 0) {
    await sheetsClient.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: tabsToCreate.map((title) => ({ addSheet: { properties: { title } } })) },
    });
    console.log('Created tabs:', tabsToCreate.join(', '));
  } else {
    console.log('Wallet, Users, and Reimbursements tabs already exist — skipping creation.');
  }

  await sheetsClient.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: 'Wallet!A1:H1',
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [['Timestamp', 'TelegramID', 'Nickname', 'Type', 'Brand', 'Category', 'Amount', 'Description']],
    },
  });
  console.log('Wallet headers written.');

  await sheetsClient.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: 'Users!A1:H1',
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [['TelegramID', 'Username', 'Nickname', 'Status', 'RequestedAt', 'ApprovedAt', 'ApprovedBy', 'LastFlaggedAt']],
    },
  });
  console.log('Users headers written.');

  await sheetsClient.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: 'Reimbursements!A1:K1',
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [['ID', 'Timestamp', 'TelegramID', 'Nickname', 'Brand', 'Category', 'Amount', 'Description', 'Status', 'SettledAt', 'SettledBy']],
    },
  });
  console.log('Reimbursements headers written.');

  const expHeaderRes = await sheetsClient.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${EXPENSES_TAB}!A1:G1`,
  });
  const headerRow = (expHeaderRes.data.values && expHeaderRes.data.values[0]) || [];
  if (headerRow[6] !== 'Source') {
    await sheetsClient.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${EXPENSES_TAB}!G1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [['Source']] },
    });
    console.log(`Added "Source" header to ${EXPENSES_TAB} tab (column G).`);
  } else {
    console.log(`${EXPENSES_TAB} tab already has a "Source" header — skipping.`);
  }

  console.log('Done.');
}

main().catch((err) => {
  console.error('Provisioning failed:', err.message || err);
  process.exit(1);
});
