const { sheets } = require('@googleapis/sheets');
const { GoogleAuth } = require('google-auth-library');

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const EXPENSES_TAB = process.env.GOOGLE_SHEET_TAB || 'Expenses';
const WALLET_TAB = 'Wallet';
const USERS_TAB = 'Users';
const BUDGETS_TAB = 'Budgets';

let cachedClient = null;

// Nothing in the googleapis/gaxios chain sets its own request timeout, so a
// stalled connection (seen in production on cold starts) hangs until
// Telegraf's own 90s handlerTimeout kills the whole update — by which point
// no reply was ever sent and the button just looks dead. Racing every call
// against a much shorter timeout here means our own try/catch blocks
// actually get a chance to fire and tell the user something went wrong.
const SHEETS_TIMEOUT_MS = 8000;

function withTimeout(promise, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Google Sheets request timed out after ${SHEETS_TIMEOUT_MS}ms (${label})`)), SHEETS_TIMEOUT_MS);
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

// Short-lived in-memory cache for full-tab reads. A live Sheets round-trip
// can't be made sub-second on every call, but a warm serverless instance
// often handles several taps from the same session in a row — those repeat
// reads can be served from memory instead of hitting Sheets again. Any write
// invalidates its tab immediately, so nothing ever serves stale data after
// its own action; only good for the same warm instance, a cold start still
// starts empty.
const CACHE_TTL_MS = 20000;
const cache = {};

async function cached(key, fetchFn) {
  const entry = cache[key];
  if (entry && Date.now() - entry.at < CACHE_TTL_MS) return entry.value;
  const value = await fetchFn();
  cache[key] = { value, at: Date.now() };
  return value;
}

function invalidate(key) {
  delete cache[key];
}

// Uses the scoped @googleapis/sheets + google-auth-library packages instead
// of the full `googleapis` bundle — same API, but require() takes ~200ms
// instead of ~1.7s, which matters on every serverless cold start.
async function getSheetsClient() {
  if (cachedClient) return cachedClient;

  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const authClient = await withTimeout(auth.getClient(), 'auth.getClient');
  cachedClient = sheets({ version: 'v4', auth: authClient });
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
  await withTimeout(
    sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${EXPENSES_TAB}!A:G`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [[timestamp, brand, category, amount, description || '', user || '', source || '']],
      },
    }),
    'appendExpense'
  );
  invalidate('expenses');
}

async function getAllExpenseRows() {
  return cached('expenses', async () => {
    const sheets = await getSheetsClient();
    const res = await withTimeout(
      sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `${EXPENSES_TAB}!A2:G`,
      }),
      'getAllExpenseRows'
    );
    return res.data.values || [];
  });
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
  await withTimeout(
    sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${WALLET_TAB}!A:H`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [[timestamp, String(telegramId), nickname || '', type, brand || '', category || '', amount, description || '']],
      },
    }),
    'appendWalletTransaction'
  );
  invalidate('wallet');
}

async function getAllWalletRows() {
  return cached('wallet', async () => {
    const sheets = await getSheetsClient();
    const res = await withTimeout(
      sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: WALLET_RANGE,
      }),
      'getAllWalletRows'
    );
    return res.data.values || [];
  });
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
/* Reimbursements — money an employee fronted from their own pocket, owed */
/* back by the company. Tracked separately from the cash wallet.          */
/* Columns: ID | Timestamp | TelegramID | Nickname | Brand | Category |   */
/*          Amount | Description | Status | SettledAt | SettledBy        */
/* ---------------------------------------------------------------------- */

const REIMBURSEMENTS_TAB = 'Reimbursements';
const REIMB_RANGE = `${REIMBURSEMENTS_TAB}!A2:K`;
const REIMB_COL_COUNT = 11;

function generateReimbursementId() {
  return require('crypto').randomBytes(3).toString('hex').toUpperCase(); // e.g. "A1B2C3"
}

async function appendReimbursement({ telegramId, nickname, brand, category, amount, description }) {
  const id = generateReimbursementId();
  const timestamp = new Date().toISOString();
  const row = [id, timestamp, String(telegramId), nickname || '', brand, category, amount, description || '', 'Pending', '', ''];
  const sheets = await getSheetsClient();
  await withTimeout(
    sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${REIMBURSEMENTS_TAB}!A:K`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    }),
    'appendReimbursement'
  );
  invalidate('reimbursements');
  return id;
}

async function getAllReimbursementRows() {
  return cached('reimbursements', async () => {
    const sheets = await getSheetsClient();
    const res = await withTimeout(
      sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: REIMB_RANGE,
      }),
      'getAllReimbursementRows'
    );
    return res.data.values || [];
  });
}

async function getPendingReimbursements() {
  const rows = await getAllReimbursementRows();
  return rows.filter((r) => (r[8] || '') === 'Pending');
}

// Returns { rowNumber (1-indexed, matches actual sheet row), values } or null.
async function findReimbursementById(id) {
  const rows = await getAllReimbursementRows();
  const target = String(id).trim().toUpperCase();
  const idx = rows.findIndex((r) => (r[0] || '').trim().toUpperCase() === target);
  if (idx === -1) return null;
  return { rowNumber: idx + 2, values: rows[idx] };
}

async function writeReimbursementRow(rowNumber, values) {
  const sheets = await getSheetsClient();
  const padded = values.slice(0, REIMB_COL_COUNT);
  while (padded.length < REIMB_COL_COUNT) padded.push('');
  await withTimeout(
    sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${REIMBURSEMENTS_TAB}!A${rowNumber}:K${rowNumber}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [padded] },
    }),
    'writeReimbursementRow'
  );
  invalidate('reimbursements');
}

// Returns null if the ID doesn't exist, otherwise { alreadySettled, values }.
async function settleReimbursement(id, settledBy) {
  const found = await findReimbursementById(id);
  if (!found) return null;
  const v = found.values.slice(0, REIMB_COL_COUNT);
  while (v.length < REIMB_COL_COUNT) v.push('');
  if (v[8] !== 'Pending') return { alreadySettled: true, values: v };
  v[8] = 'Paid';
  v[9] = new Date().toISOString();
  v[10] = settledBy || '';
  await writeReimbursementRow(found.rowNumber, v);
  return { alreadySettled: false, values: v };
}

/* ---------------------------------------------------------------------- */
/* Users — registration + admin approval                                  */
/* Columns: TelegramID | Username | Nickname | Status | RequestedAt |     */
/*          ApprovedAt | ApprovedBy | LastFlaggedAt                       */
/* ---------------------------------------------------------------------- */

const USER_RANGE = `${USERS_TAB}!A2:H`;
const USER_COL_COUNT = 8;

async function getAllUsers() {
  return cached('users', async () => {
    const sheets = await getSheetsClient();
    const res = await withTimeout(
      sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: USER_RANGE,
      }),
      'getAllUsers'
    );
    return res.data.values || [];
  });
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
  await withTimeout(
    sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${USERS_TAB}!A:H`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    }),
    'registerUser'
  );
  invalidate('users');
}

async function writeUserRow(rowNumber, values) {
  const sheets = await getSheetsClient();
  const padded = values.slice(0, USER_COL_COUNT);
  while (padded.length < USER_COL_COUNT) padded.push('');
  await withTimeout(
    sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${USERS_TAB}!A${rowNumber}:H${rowNumber}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [padded] },
    }),
    'writeUserRow'
  );
  invalidate('users');
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
  let rows;
  try {
    rows = await cached('budgets', async () => {
      const sheets = await getSheetsClient();
      const res = await withTimeout(
        sheets.spreadsheets.values.get({
          spreadsheetId: SHEET_ID,
          range: `${BUDGETS_TAB}!A2:C`,
        }),
        'getBudgets'
      );
      return res.data.values || [];
    });
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
  appendReimbursement,
  getPendingReimbursements,
  findReimbursementById,
  settleReimbursement,
  getAllUsers,
  findUser,
  nicknameTaken,
  registerUser,
  setUserStatus,
  markUserFlagged,
  getBudgets,
  getMonthlySummary,
};
