const { google } = require('googleapis');

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const EXPENSES_TAB = process.env.GOOGLE_SHEET_TAB || 'Expenses';
const WALLET_TAB = 'Wallet';
const USERS_TAB = 'Users';
const BUDGETS_TAB = 'Budgets';

let cachedClient = null;

async function getSheetsClient() {
  if (cachedClient) return cachedClient;

  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const authClient = await auth.getClient();
  cachedClient = google.sheets({ version: 'v4', auth: authClient });
  return cachedClient;
}

/* ---------------------------------------------------------------------- */
/* Expenses (money actually spent — from a wallet, or paid directly)      */
/* Columns: Timestamp | Brand | Category | Amount | Description | User |  */
/*          Source ("Wallet" or "Direct")                                 */
/* ---------------------------------------------------------------------- */

async function appendExpense({ brand, category, amount, description, user, source }) {
  const sheets = await getSheetsClient();
  const timestamp = new Date().toISOString();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${EXPENSES_TAB}!A:G`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [[timestamp, brand, category, amount, description || '', user || '', source || '']],
    },
  });
}

async function getAllExpenseRows() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${EXPENSES_TAB}!A2:G`,
  });
  return res.data.values || [];
}

async function getTodayExpenseRows() {
  const rows = await getAllExpenseRows();
  const todayStr = new Date().toDateString();
  return rows.filter((row) => row[0] && new Date(row[0]).toDateString() === todayStr);
}

/* ---------------------------------------------------------------------- */
/* Wallet — a running cash ledger per person. TopUp adds cash (positive), */
/* Expense/Return remove it (stored as negative amounts). Balance = sum.  */
/* Columns: Timestamp | TelegramID | Nickname | Type | Brand | Category | */
/*          Amount | Description                                         */
/* ---------------------------------------------------------------------- */

const WALLET_RANGE = `${WALLET_TAB}!A2:H`;

async function appendWalletTransaction({ telegramId, nickname, type, brand, category, amount, description }) {
  const sheets = await getSheetsClient();
  const timestamp = new Date().toISOString();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${WALLET_TAB}!A:H`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [[timestamp, String(telegramId), nickname || '', type, brand || '', category || '', amount, description || '']],
    },
  });
}

async function getAllWalletRows() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: WALLET_RANGE,
  });
  return res.data.values || [];
}

// { [telegramId]: { telegramId, nickname, balance, lastActivity } }
function computeWalletBalances(rows) {
  const byUser = {};
  for (const r of rows) {
    const [timestamp, telegramId, nickname, , , , amount] = r;
    if (!telegramId) continue;
    const amt = parseFloat(amount) || 0;
    if (!byUser[telegramId]) byUser[telegramId] = { telegramId, nickname, balance: 0, lastActivity: timestamp };
    byUser[telegramId].balance += amt;
    if (nickname) byUser[telegramId].nickname = nickname;
    if (timestamp && new Date(timestamp) > new Date(byUser[telegramId].lastActivity || 0)) {
      byUser[telegramId].lastActivity = timestamp;
    }
  }
  return byUser;
}

async function getWalletBalance(telegramId) {
  const rows = await getAllWalletRows();
  const target = String(telegramId);
  let balance = 0;
  for (const r of rows) {
    if (String(r[1]) === target) balance += parseFloat(r[6]) || 0;
  }
  return balance;
}

async function getAllWalletBalances() {
  const rows = await getAllWalletRows();
  return computeWalletBalances(rows);
}

// Users whose wallet balance is still positive `hoursThreshold`+ after their
// last wallet activity, not already reflagged within `reflagHours`.
async function getStaleWallets(hoursThreshold, reflagHours) {
  const [walletRows, userRows] = await Promise.all([getAllWalletRows(), getAllUsers()]);
  const balances = computeWalletBalances(walletRows);
  const now = Date.now();
  const stale = [];
  for (const info of Object.values(balances)) {
    if (info.balance <= 0.5) continue;
    const lastActivity = new Date(info.lastActivity).getTime();
    if (Number.isNaN(lastActivity)) continue;
    const hoursOpen = (now - lastActivity) / (1000 * 60 * 60);
    if (hoursOpen < hoursThreshold) continue;

    const userRow = userRows.find((r) => String(r[0]) === String(info.telegramId));
    const lastFlaggedAt = userRow ? userRow[7] : '';
    const hoursSinceFlag = lastFlaggedAt ? (now - new Date(lastFlaggedAt).getTime()) / (1000 * 60 * 60) : Infinity;
    if (hoursSinceFlag < reflagHours) continue;

    stale.push({ telegramId: info.telegramId, nickname: info.nickname, balance: info.balance, hoursOpen });
  }
  return stale;
}

/* ---------------------------------------------------------------------- */
/* Users — registration + admin approval                                  */
/* Columns: TelegramID | Username | Nickname | Status | RequestedAt |     */
/*          ApprovedAt | ApprovedBy | LastFlaggedAt                       */
/* ---------------------------------------------------------------------- */

const USER_RANGE = `${USERS_TAB}!A2:H`;
const USER_COL_COUNT = 8;

async function getAllUsers() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: USER_RANGE,
  });
  return res.data.values || [];
}

// Returns { rowNumber (1-indexed, matches actual sheet row), values } or null.
async function findUser(telegramId) {
  const rows = await getAllUsers();
  const target = String(telegramId);
  const idx = rows.findIndex((r) => String(r[0]) === target);
  if (idx === -1) return null;
  return { rowNumber: idx + 2, values: rows[idx] };
}

async function nicknameTaken(nickname) {
  const rows = await getAllUsers();
  const target = nickname.trim().toLowerCase();
  return rows.some((r) => (r[2] || '').trim().toLowerCase() === target);
}

async function registerUser(telegramId, username, nickname) {
  const sheets = await getSheetsClient();
  const row = [String(telegramId), username || '', nickname, 'Pending', new Date().toISOString(), '', '', ''];
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${USERS_TAB}!A:H`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
}

async function writeUserRow(rowNumber, values) {
  const sheets = await getSheetsClient();
  const padded = values.slice(0, USER_COL_COUNT);
  while (padded.length < USER_COL_COUNT) padded.push('');
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${USERS_TAB}!A${rowNumber}:H${rowNumber}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [padded] },
  });
}

async function setUserStatus(telegramId, status, approvedBy) {
  const found = await findUser(telegramId);
  if (!found) return null;
  const v = found.values.slice(0, USER_COL_COUNT);
  while (v.length < USER_COL_COUNT) v.push('');
  v[3] = status;
  if (status === 'Approved') {
    v[5] = new Date().toISOString();
    v[6] = approvedBy || '';
  }
  await writeUserRow(found.rowNumber, v);
  return v;
}

async function markUserFlagged(telegramId) {
  const found = await findUser(telegramId);
  if (!found) return;
  const v = found.values.slice(0, USER_COL_COUNT);
  while (v.length < USER_COL_COUNT) v.push('');
  v[7] = new Date().toISOString();
  await writeUserRow(found.rowNumber, v);
}

/* ---------------------------------------------------------------------- */
/* Budgets — Brand | Category | MonthlyBudget (edited by hand in Sheets)  */
/* ---------------------------------------------------------------------- */

async function getBudgets() {
  const sheets = await getSheetsClient();
  let rows;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${BUDGETS_TAB}!A2:C`,
    });
    rows = res.data.values || [];
  } catch (err) {
    return {}; // Budgets tab not set up yet — budget comparison is optional
  }

  const budgets = {};
  for (const [brand, category, amount] of rows) {
    if (!brand || !category) continue;
    budgets[brand] = budgets[brand] || {};
    budgets[brand][category] = parseFloat(amount) || 0;
  }
  return budgets;
}

/* ---------------------------------------------------------------------- */
/* Monthly summary: every logged Expense (wallet-drawn or direct)         */
/* ---------------------------------------------------------------------- */

async function getMonthlySummary(targetDate = new Date()) {
  const month = targetDate.getMonth();
  const year = targetDate.getFullYear();
  const totals = {};

  const expenseRows = await getAllExpenseRows();
  for (const [ts, brand, category, amount] of expenseRows) {
    if (!ts || !brand) continue;
    const d = new Date(ts);
    if (d.getMonth() !== month || d.getFullYear() !== year) continue;
    totals[brand] = totals[brand] || {};
    totals[brand][category] = (totals[brand][category] || 0) + (parseFloat(amount) || 0);
  }

  return totals;
}

module.exports = {
  appendExpense,
  getAllExpenseRows,
  getTodayExpenseRows,
  appendWalletTransaction,
  getWalletBalance,
  getAllWalletBalances,
  getStaleWallets,
  getAllUsers,
  findUser,
  nicknameTaken,
  registerUser,
  setUserStatus,
  markUserFlagged,
  getBudgets,
  getMonthlySummary,
};
