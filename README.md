# Little Britain / WorldLink Expense & Cash Advance Bot

Tracks two different kinds of money movement:

- **Direct expenses** (`/expense`) — you already paid for something, log it for the records.
- **Cash advances** (`/advance` → `/settle`) — money is handed to someone *before* they buy anything.
  This is where the "who pocketed the change" problem lives, so the bot forces a
  three-way match every time: **cash given** vs **receipt total** vs **change returned**.
  Any gap between them is flagged automatically, by name, every time you run `/report`.

Deploys the same way as littlebritaindaycare.com: GitHub → Vercel.

---

## What the bot does

| Command | Purpose |
|---|---|
| `/expense` | Log a direct purchase/reimbursement (no advance risk) |
| `/advance` | Record cash handed to someone in advance |
| `/settle <ID>` | Reconcile an advance — the bot asks one simple question at a time |
| `/open` | List advances not yet settled, with how many hours they've been outstanding |
| `/receipt <ID>` | Re-show a saved receipt photo/PDF on demand |
| `/today` | Today's direct expenses |
| `/report` | This month: spend vs budget, outstanding cash, flagged discrepancies |
| `/getid` | Shows this chat's Telegram ID (needed for overdue alerts, see Phase 6) |

A scheduled check (once a day) also flags any advance still open after 24 hours,
even if nobody runs `/open` — see Phase 6.

---

## 1. Create the Telegram bot

1. In Telegram, message **@BotFather**.
2. Send `/newbot`, follow the prompts, name it (e.g. "LB WorldLink Expenses").
3. Copy the token it gives you (`123456:ABC-DEF...`) → save as `BOT_TOKEN`.

## 2. Create the Google Sheet (3 tabs)

Create a new Google Sheet (**sheets.new**), then set up three tabs exactly as below
— tab names and headers must match exactly.

**Tab 1 — `Expenses`**
`Timestamp | Brand | Category | Amount | Description | User`

**Tab 2 — `Advances`**
`ID | IssuedAt | Brand | Category | AmountIssued | Purpose | IssuedTo | Status | SettledAt | AmountSpent | ChangeReturned | Discrepancy | ReceiptFileId | ReceiptType | Note | LastFlaggedAt`

**Tab 3 — `Budgets`** *(optional but recommended — this is what powers the "over budget" warnings)*
`Brand | Category | MonthlyBudget`
Fill in one row per brand/category you want to track, e.g.:
`Little Britain | Food & Catering | 3000000`
Leave categories out that you don't want a budget cap on.

Copy the **Sheet ID** from the URL:
`https://docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit` → save as `GOOGLE_SHEET_ID`.

## 3. Let Google write to the sheet

1. Go to **console.cloud.google.com** → create a project (e.g. `expense-bot`).
2. Enable the **Google Sheets API** for it (search bar → find it → Enable).
3. **IAM & Admin → Service Accounts → Create Service Account** → any name → Create and Continue → Continue → Done.
4. Open it → **Keys → Add Key → Create new key → JSON** → downloads a `.json` file.
5. Open that file, find `"client_email"` → copy the email.
6. In your Google Sheet, **Share** → paste that email → **Editor** access.
7. Copy the **entire contents** of the `.json` file → save as `GOOGLE_SERVICE_ACCOUNT_JSON`.

## 4. Push the code to GitHub

1. Unzip `expense-bot.zip`.
2. On github.com: **+ → New repository** → name it `expense-bot` → Private → Create.
3. Click **"uploading an existing file"** → drag in everything from the unzipped folder → **Commit changes**.

## 5. Deploy to Vercel

1. **Add New → Project** → import the `expense-bot` repo.
2. Add these **Environment Variables** before deploying:

   | Name | Value |
   |---|---|
   | `BOT_TOKEN` | from Phase 1 |
   | `GOOGLE_SHEET_ID` | from Phase 2 |
   | `GOOGLE_SERVICE_ACCOUNT_JSON` | full JSON blob from Phase 3 |
   | `DISCREPANCY_TOLERANCE` | `2000` (or your preferred tolerance in UZS) |
   | `ALERT_CHAT_ID` | leave blank for now — you'll add it in Phase 6 |

3. **Deploy**. Copy the resulting URL, e.g. `https://expense-bot-sinus05.vercel.app`.

## 6. Turn on overdue alerts

1. Message your bot `/getid` — it replies with a number. That's your chat's Telegram ID.
2. In Vercel → Project → Settings → Environment Variables, set `ALERT_CHAT_ID` to that number.
3. Redeploy (Vercel → Deployments → ⋯ → Redeploy) so the new variable takes effect.

This project includes `vercel.json`, which registers a **daily** check (`/api/check-overdue`)
that messages `ALERT_CHAT_ID` listing any advance still open past `OVERDUE_HOURS` (default 24h).

> **Note on timing:** Vercel's free Hobby plan only allows cron jobs to run **once per day**,
> and the exact minute can drift within that hour — it is not a live, minute-by-minute check.
> In practice this means an overdue advance gets flagged once a day, which is normally enough
> to catch money that's been sitting out too long. If you want faster (e.g. hourly) alerts,
> that requires Vercel's paid Pro plan ($20/mo). Also worth knowing: Vercel's Hobby tier is
> intended for non-commercial use under their fair-use terms — something to keep in mind since
> this is a business tool, even though many small teams run exactly this kind of thing on it.

## 7. Set the Telegram webhook

Paste this into your browser address bar (fill in your own token and Vercel URL) and press Enter:

```
https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=<VERCEL_URL>/api/webhook
```

You should see `{"ok":true,"result":true,...}`.

## 8. Test it

1. `/start` — see the command list.
2. `/advance` → pick a brand → pick a category → reply `500000 test advance`.
3. Bot replies with an ID, e.g. `A1B2C3`.
4. `/settle A1B2C3` → bot asks "Do you have a receipt?" — tap **No receipt**.
5. Bot asks "how much was actually spent?" → reply `450000`.
6. Bot asks "how much change was returned?" → reply `30000`.
7. Since 500000 ≠ 450000 + 30000, the bot should reply `🚩 Short by 20,000 UZS`.
6. Check the `Advances` tab — the row should now show `Settled` (or `Settled-Discrepancy`), with the numbers filled in.
7. Delete the test row when done.

---

## How this actually catches the problem

Before: cash goes out, receipts trickle back "sometimes," and nobody can say
with certainty whether what came back matches what went out.

After: every advance has an ID, an owner, and a deadline. Settling it requires
typing the actual amount spent and change returned — and the sheet does the
subtraction for you. A shortfall doesn't require anyone to go looking for it;
it appears in `/report` under 🚩 Discrepancies, tied to whoever the cash was
given to, every single month, whether or not a receipt was attached.

## Customizing

- **Categories/brands**: edit `lib/categories.js`.
- **Budgets**: edit the `Budgets` tab directly in the sheet — no redeploy needed.
- **Tolerance / overdue timing**: adjust `DISCREPANCY_TOLERANCE`, `OVERDUE_HOURS`,
  `REFLAG_HOURS` in Vercel's environment variables.
- **Who can use it**: currently open to anyone who finds the bot. If you want it
  restricted to specific staff, tell me their Telegram usernames and I'll add an allow-list.

## Troubleshooting

| Symptom | Likely fix |
|---|---|
| Bot doesn't respond | Recheck the Phase 7 URL — typo in token, or missing `/api/webhook` |
| "Could not save" errors | Service account wasn't given Editor on the sheet, or `GOOGLE_SHEET_ID` is wrong |
| No budget line in `/report` | `Budgets` tab missing, misnamed, or that brand/category has no row there |
| No overdue alerts | `ALERT_CHAT_ID` not set, or a day hasn't passed yet — see Phase 6's timing note |
| `/receipt` fails on an old entry | Telegram file references can occasionally stop resolving after a very long time — this is rare but possible for receipts from many months back |
| Detailed errors | Vercel dashboard → project → Deployments → latest → View Function Logs |
