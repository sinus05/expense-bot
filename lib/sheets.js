const { google } = require('googleapis');

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const EXPENSES_TAB = process.env.GOOGLE_SHEET_TAB || 'Expenses';
const ADVANCES_TAB = 'Advances';
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
/* Expenses (direct purchases / reimbursements — no cash handed out first) */
/* ---------------------------------------------------------------------- */

// Row shape: [timestamp, brand, category, amount, description, telegramUser]
async function appendExpense({ brand, category, amount, description, user }) {
  const sheets = await getSheetsClient();
  const timestamp = new Date().toISOString();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${EXPENSES_TAB}!A:F`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [[timestamp, brand, category, amount, description || '', user || '']],
    },
  });
}

async function getAllExpenseRows() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${EXPENSES_TAB}!A2:F`,
  });
  return res.data.values || [];
}

async function getTodayExpenseRows() {
  const rows = await getAllExpenseRows();
  const todayStr = new Date().toDateString();
  return rows.filter((row) => row[0] && new Date(row[0]).toDateString() === todayStr);
}

/* ---------------------------------------------------------------------- */
/* Advances (cash handed out in advance, settled later against receipts)  */
/* Columns: ID | IssuedAt | Brand | Category | AmountIssued | Purpose |   */
/*          IssuedTo | Status | SettledAt | AmountSpent | ChangeReturned |*/
/*          Discrepancy | ReceiptFileId | ReceiptType | Note |            */
/*          LastFlaggedAt                                                 */
/* ---------------------------------------------------------------------- */

const ADV_RANGE = `${ADVANCES_TAB}!A2:P`;
const ADV_COL_COUNT = 16;

function generateAdvanceId() {
  return require('crypto').randomBytes(3).toString('hex').toUpperCase(); // e.g. "A1B2C3"
}

async function appendAdvance({ brand, category, amount, purpose, issuedTo }) {
  const sheets = await getSheetsClient();
  const id = generateAdvanceId();
  const issuedAt = new Date().toISOString();
  const row = [
    id, issuedAt, brand, category, amount, purpose || '', issuedTo || '',
    'Open', '', '', '', '', '', '', '', '',
  ];
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${ADVANCES_TAB}!A:P`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
  return id;
}

async function getAllAdvanceRows() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: ADV_RANGE,
  });
  return res.data.values || [];
}

// Returns { rowNumber (1-indexed, matches actual sheet row), values } or null.
async function findAdvanceById(id) {
  const rows = await getAllAdvanceRows();
  const target = String(id).trim().toUpperCase();
  const idx = rows.findIndex((r) => (r[0] || '').trim().toUpperCase() === target);
  if (idx === -1) return null;
  return { rowNumber: idx + 2, values: rows[idx] }; // +2: header row + 0-index offset
}

async function writeAdvanceRow(rowNumber, values) {
  const sheets = await getSheetsClient();
  const padded = values.slice(0, ADV_COL_COUNT);
  while (padded.length < ADV_COL_COUNT) padded.push('');
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${ADVANCES_TAB}!A${rowNumber}:P${rowNumber}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [padded] },
  });
}

async function settleAdvance(id, { amountSpent, changeReturned, receiptFileId, receiptType, note, tolerance }) {
  const found = await findAdvanceById(id);
  if (!found) return null;

  const v = found.values;
  const amountIssued = parseFloat(v[4]) || 0;
  const discrepancy = amountIssued - (amountSpent + changeReturned);
  const status = Math.abs(discrepancy) > tolerance ? 'Settled-Discrepancy' : 'Settled';

  const updated = [
    v[0], v[1], v[2], v[3], v[4], v[5], v[6],
    status,
    new Date().toISOString(),
    amountSpent,
    changeReturned,
    discrepancy,
    receiptFileId || '',
    receiptType || 'none',
    note || '',
    v[15] || '',
  ];
  await writeAdvanceRow(found.rowNumber, updated);
  return { ...found, updated, discrepancy, status, brand: v[2], category: v[3], amountIssued };
}

async function getOpenAdvances() {
  const rows = await getAllAdvanceRows();
  return rows.filter((r) => (r[7] || '') === 'Open');
}

// Advances open longer than `hoursThreshold`, not flagged in the last `reflagHours`.
async function getOverdueAdvances(hoursThreshold, reflagHours) {
  const rows = await getAllAdvanceRows();
  const now = Date.now();
  const overdue = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if ((r[7] || '') !== 'Open') continue;
    const issuedAt = new Date(r[1]).getTime();
    if (Number.isNaN(issuedAt)) continue;
    const hoursOpen = (now - issuedAt) / (1000 * 60 * 60);
    if (hoursOpen < hoursThreshold) continue;

    const lastFlagged = r[15] ? new Date(r[15]).getTime() : 0;
    const hoursSinceFlag = lastFlagged ? (now - lastFlagged) / (1000 * 60 * 60) : Infinity;
    if (hoursSinceFlag < reflagHours) continue;

    overdue.push({ rowNumber: i + 2, values: r, hoursOpen });
  }
  return overdue;
}

async function markAdvanceFlagged(rowNumber, values) {
  const updated = values.slice(0, ADV_COL_COUNT);
  while (updated.length < ADV_COL_COUNT) updated.push('');
  updated[15] = new Date().toISOString();
  await writeAdvanceRow(rowNumber, updated);
}

async function getSettledAdvancesThisMonth(targetDate = new Date()) {
  const rows = await getAllAdvanceRows();
  const month = targetDate.getMonth();
  const year = targetDate.getFullYear();
  return rows.filter((r) => {
    if (!r[8]) return false; // no SettledAt
    if ((r[7] || '').indexOf('Settled') !== 0) return false;
    const d = new Date(r[8]);
    return d.getMonth() === month && d.getFullYear() === year;
  });
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
/* Combined monthly summary: direct Expenses + settled Advances           */
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

  const settledAdvances = await getSettledAdvancesThisMonth(targetDate);
  for (const r of settledAdvances) {
    const brand = r[2];
    const category = r[3];
    const amountSpent = parseFloat(r[9]) || 0;
    totals[brand] = totals[brand] || {};
    totals[brand][category] = (totals[brand][category] || 0) + amountSpent;
  }

  return totals;
}

module.exports = {
  appendExpense,
  getAllExpenseRows,
  getTodayExpenseRows,
  appendAdvance,
  findAdvanceById,
  settleAdvance,
  getOpenAdvances,
  getOverdueAdvances,
  markAdvanceFlagged,
  getSettledAdvancesThisMonth,
  getBudgets,
  getMonthlySummary,
};
