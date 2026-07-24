# Little Britain / WorldLink Expense & Wallet Bot

Tracks two different kinds of money movement:

- **Direct payments** (`/directpay`) — rent, salaries, bank transfers — money that never
  passes through anyone's hands as cash.
- **Cash wallets** (`/advance` to top up → `/expense` to spend → `/return` to hand back
  what's left) — every person who carries cash for the business has a running wallet
  balance. Spending more than you're holding simply isn't allowed: the bot blocks it
  and tells you how short you are. There's nothing to reconcile after the fact —
  the math is enforced at the moment of spending.

Access is gated: new chats have to register a nickname and get approved by an admin
before they can touch any money command.

Deploys the same way as littlebritaindaycare.com: GitHub → Vercel.

---

## What the bot does

| Command | Purpose |
|---|---|
| `/start` | Register (first time) or show the quick-action menu |
| `/expense` | Log a cash purchase — deducted from your wallet automatically |
| `/directpay` | Log a payment that didn't come from cash (rent, salary, bank transfer) |
| `/advance` | Top up your cash wallet (you're taking cash to go spend) |
| `/return` | Hand back cash you didn't spend, reducing your wallet balance |
| `/wallet` | Your current wallet balance |
| `/wallets` | Everyone's current wallet balance, and how long they've held it |
| `/today` | Today's logged expenses |
| `/report` | This month: spend vs budget, cash still outstanding |
| `/cancel` | Bail out of whatever prompt you're mid-reply to |
| `/getid` | Shows this chat's Telegram ID (needed for admin/alert setup) |

A scheduled check (once a day) also flags any wallet still holding cash 24h+ after
its last activity, even if nobody runs `/wallets` — see Phase 6.

---

## 1. Create the Telegram bot

1. In Telegram, message **@BotFather**.
2. Send `/newbot`, follow the prompts, name it (e.g. "LB WorldLink Expenses").
3. Copy the token it gives you (`123456:ABC-DEF...`) → save as `BOT_TOKEN`.

## 2. Create the Google Sheet (4 tabs)

Create a new Google Sheet (**sheets.new**), then set up four tabs exactly as below
— tab names and headers must match exactly.

**Tab 1 — `Expenses`**
`Timestamp | Brand | Category | Amount | Description | User | Source`
(`Source` is filled in automatically — `Wallet` or `Direct`.)

**Tab 2 — `Wallet`**
`Timestamp | TelegramID | Nickname | Type | Brand | Category | Amount | Description`
This is a running ledger, not something you edit by hand — `Type` is `TopUp`,
`Expense`, or `Return`, and a person's current balance is just the sum of their rows.

**Tab 3 — `Users`**
`TelegramID | Username | Nickname | Status | RequestedAt | ApprovedAt | ApprovedBy | LastFlaggedAt`
Filled in automatically as people register and get approved/denied. You generally
won't need to edit this by hand.

**Tab 4 — `Budgets`** *(optional but recommended — this is what powers the "over budget" warnings)*
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

1. Unzip `expense-bot.zip` (or use this repo directly).
2. On github.com: **+ → New repository** → name it `expense-bot` → Private → Create.
3. Push/upload the code → **Commit changes**.

## 5. Deploy to Vercel

1. **Add New → Project** → import the `expense-bot` repo.
2. Add these **Environment Variables** before deploying:

   | Name | Value |
   |---|---|
   | `BOT_TOKEN` | from Phase 1 |
   | `GOOGLE_SHEET_ID` | from Phase 2 |
   | `GOOGLE_SERVICE_ACCOUNT_JSON` | full JSON blob from Phase 3 |
   | `ADMIN_IDS` | leave blank for now — you'll add it in Phase 6 |
   | `ALERT_CHAT_ID` | leave blank for now — you'll add it in Phase 6 |

3. **Deploy**. Copy the resulting URL, e.g. `https://expense-bot-sinus05.vercel.app`.

## 6. Set yourself up as admin

1. Message your bot `/getid` — it replies with a number. That's your Telegram ID
   (this works even before you're registered).
2. In Vercel → Project → Settings → Environment Variables, set `ADMIN_IDS` to that
   number (comma-separate if there's more than one admin, e.g. `111,222`).
3. Set `ALERT_CHAT_ID` to the same chat ID (or a group chat you want registration
   requests and stale-wallet alerts sent to).
4. Redeploy (Vercel → Deployments → ⋯ → Redeploy) so the new variables take effect.

Admins skip registration entirely and are the only ones who can tap **Approve/Deny**
on new registration requests.

> **Note on timing:** Vercel's free Hobby plan only allows cron jobs to run **once per day**,
> and the exact minute can drift within that hour — it is not a live, minute-by-minute check.
> If you want faster (e.g. hourly) alerts, that requires Vercel's paid Pro plan ($20/mo).
> Also worth knowing: Vercel's Hobby tier is intended for non-commercial use under their
> fair-use terms — something to keep in mind since this is a business tool, even though
> many small teams run exactly this kind of thing on it.

## 7. Set the Telegram webhook

Paste this into your browser address bar (fill in your own token and Vercel URL) and press Enter:

```
https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=<VERCEL_URL>/api/webhook
```

You should see `{"ok":true,"result":true,...}`.

## 8. Test it

1. `/start` — as a non-admin test account, this asks for a nickname, then sends a
   request to `ALERT_CHAT_ID` with Approve/Deny buttons.
2. Approve it from the admin account → the test account gets notified and can now `/start` again to see the menu.
3. `/advance` → pick a brand → pick a category → reply `500000 test top-up`. Bot confirms a wallet balance of 500,000.
4. `/expense` → pick a brand/category → reply `450000 test purchase`. Bot deducts it, new balance 50,000.
5. `/expense` again for `100000 another purchase` → bot should refuse: not enough in the wallet.
6. `/return 50000` → wallet balance goes to 0.
7. Check the `Wallet` and `Expenses` tabs — rows should match what you just did. Delete the test rows when done.

---

## How this actually works

Before: cash goes out, receipts trickle back "sometimes," and reconciling what
was spent against what was handed out happens after the fact — if at all.

After: every person's wallet is just a running total (top-ups minus what they've
logged as spent or returned). Logging an expense checks the balance **before**
it's allowed to save — so the sheet can never end up saying someone spent money
they never had. There's no separate settlement step and nothing to reconcile.

## Customizing

- **Categories/brands**: edit `lib/categories.js`.
- **Budgets**: edit the `Budgets` tab directly in the sheet — no redeploy needed.
- **Overdue timing**: adjust `OVERDUE_HOURS`, `REFLAG_HOURS` in Vercel's environment variables.
- **Who can use it**: gated by registration + admin approval (see Phase 6). To add another
  admin, add their Telegram ID to `ADMIN_IDS`.

## Troubleshooting

| Symptom | Likely fix |
|---|---|
| Bot doesn't respond | Recheck the Phase 7 URL — typo in token, or missing `/api/webhook` |
| "Could not save" errors | Service account wasn't given Editor on the sheet, or `GOOGLE_SHEET_ID` is wrong, or a tab is missing/misnamed |
| Stuck at "awaiting admin approval" | An admin needs to tap Approve on the request sent to `ALERT_CHAT_ID` — check `ADMIN_IDS` is set correctly |
| No budget line in `/report` | `Budgets` tab missing, misnamed, or that brand/category has no row there |
| No stale-wallet alerts | `ALERT_CHAT_ID` not set, or a day hasn't passed yet — see Phase 6's timing note |
| Detailed errors | Vercel dashboard → project → Deployments → latest → View Function Logs |
