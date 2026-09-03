# Setup — click by click, no terminal

Everything here is done in a web browser. There is nothing to install on your
computer, and no commands to type.

**What you are building:** a website your team opens with a link. Cashiers open
it on a phone or tablet to take payments. Attendees open it to see their balance.
You open it to run the event. Nobody installs anything, ever.

---

## Before you start

You need logins for three sites (all free to start):

- **GitHub** — where the code lives
- **Vercel** — the company that runs the app
- **Supabase** — the company that stores the data

Your database is already created and waiting:
https://supabase.com/dashboard/project/odovefouvbjsixklarhv

---

## Step 1 — Let Vercel see your code

Go to **https://github.com/apps/vercel** → click **Install** (or *Configure* if
it's already there).

Choose **Only select repositories** → pick `cashless-system-events` → **Install**.

✅ Done when GitHub returns you to a confirmation page.

---

## Step 2 — Create the app on Vercel

Go to **https://vercel.com/new**.

1. Find `cashless-system-events` in the list → click **Import**.
2. Under **Team**, choose **Nile Digital**.
3. **Do not click Deploy yet.** Go to step 3 first — deploying now just fails
   and wastes a few minutes.

---

## Step 3 — Make your secret password

The app needs one long random secret. It signs the QR codes, so it has to be
unguessable.

**Use your password manager's generator** — 1Password, Bitwarden, or the one
built into Chrome/Safari. Set the length to **64 characters**.

- ✅ Save it in your password manager. You will need it again.
- ❌ Don't type it into a random "password generator" website — those can keep
  a copy.
- ❌ Don't paste it into chat, email, or a ticket.

> **Important:** this secret can never change once the event starts. Changing it
> instantly breaks every QR code your attendees are holding.

---

## Step 4 — Get your two database addresses

Open your database:
https://supabase.com/dashboard/project/odovefouvbjsixklarhv

Click the **Connect** button at the top. You'll see several connection strings.
You need **two different ones**, and they are easy to mix up:

| Look for | Ends in port | You'll call it |
|---|---|---|
| **Transaction pooler** | `:6543` | the **app** address |
| **Session pooler** | `:5432` | the **update** address |

Copy both somewhere safe for the next two steps. Each one has a `[YOUR-PASSWORD]`
placeholder — click **Reveal**, or reset the database password on that same
screen, and paste the real password in place of the placeholder.

> ⚠️ **Do not swap these two.** They look nearly identical. Putting the wrong one
> in the wrong place breaks a safety lock silently — nothing shows an error, and
> you'd only find out when the database got corrupted. Port `6543` goes to
> Vercel. Port `5432` goes to GitHub.

---

## Step 5 — Fill in the settings on Vercel

In Vercel → your project → **Settings** → **Environment Variables**.

Add these five, one at a time (**Key** on the left, **Value** on the right):

| Key | Value |
|---|---|
| `DATABASE_URL` | the **app** address (port `6543`) from step 4 |
| `APP_SECRET` | the 64-character secret from step 3 |
| `APP_ORIGIN` | leave blank for now — you'll fill it in at step 8 |
| `TRUSTED_PROXY` | `forwarded` |
| `NEXT_PUBLIC_ENABLE_NFC_SIMULATOR` | `false` |

Make sure each is applied to **Production**.

---

## Step 6 — Give GitHub the update address

GitHub → your repository → **Settings** → **Secrets and variables** →
**Actions** → **New repository secret**.

- **Name:** `DIRECT_DATABASE_URL`
- **Secret:** the **update** address (port `5432`) from step 4

This is what lets the system build its tables and apply future updates safely.

---

## Step 7 — Go live

Open the pull request and click **Merge**:
https://github.com/jojo-j123/cashless-system-events/pull/1

Two things now happen on their own:

1. GitHub checks the code and builds the database tables.
2. Vercel builds the website and puts it online.

Watch progress in the **Actions** tab on GitHub and the **Deployments** tab on
Vercel. Give it about 3–5 minutes.

---

## Step 8 — Set your address, then check it works

Vercel gives you a link like `cashless-system-events.vercel.app`.

Go back to **Settings → Environment Variables**, set `APP_ORIGIN` to that full
address including `https://`, then **Deployments → ⋯ → Redeploy**.

*(This one is a security setting — it tells the app which website is allowed to
talk to it.)*

Then check it:

**A. Open this in your browser:**
`https://your-address.vercel.app/api/health`

You should see a short success message. That means the website reached the
database — not just that a page loaded.

**B. Prove the money adds up.** In Supabase → **SQL Editor** → paste and **Run**:

```sql
SELECT sum(balance) FROM accounts;
```

The answer must be exactly **0**. That is the whole financial guarantee in one
number: every point that exists came from somewhere and went somewhere. If it is
ever not zero, stop and investigate before taking real payments.

> **Your data is not readable from the internet.** The database host publishes
> new tables at a public web address by default. Step 7 shuts that door
> automatically, so balances can only be changed by going through the app, where
> the safety rules live. Nothing for you to do — worth knowing it was handled.

---

## Step 9 — Your own domain, on Cloudflare (optional)

Only if you own a domain and want `events.yourbrand.com` instead of a
`.vercel.app` address.

1. **Vercel** → Settings → **Domains** → add your domain. Vercel shows you a DNS
   record to create.
2. **Cloudflare** → your domain → **DNS** → add that record. Leave the orange
   cloud **on**.
3. **Cloudflare** → **SSL/TLS** → set mode to **Full (strict)**.
4. **Cloudflare** → **Rules** → **Cache Rules** → add a rule that **bypasses
   cache** for paths starting with `/api/`.
   *(Without this, Cloudflare could show someone an out-of-date balance. Never
   serve a cached balance.)*
5. **Cloudflare** → **Speed** → **Optimization** → turn **Rocket Loader off**.
   *(It breaks the page.)*
6. Back in **Vercel**, update `APP_ORIGIN` to your new domain and redeploy.

Cloudflare now guards the front door: your domain, your HTTPS padlock, attack
protection. Visitors only ever see your address.

> Leave `TRUSTED_PROXY` set to `forwarded`. Changing it to `cloudflare` is only
> safe after locking the origin so nobody can reach the app except through
> Cloudflare — see [deployment.md](./deployment.md#cloudflare-configuration).
> Setting it without that lock is worse than leaving it alone.

---

## Before the real event

Deployed and working is not the same as ready. The things that actually go wrong
on the night are card readers and settings, and no amount of testing the code
catches them.

Work through the reader setup and the soft-test checklist in
[deployment.md](./deployment.md#card-readers-settle-this-before-event-day).
Twenty people for an hour on the real system is enough to find them.

---

## If something goes wrong

| What you see | What to check |
|---|---|
| Vercel deploy fails | **Deployments** tab → click the failed one → read the log |
| Site loads, but everything errors | `DATABASE_URL` is probably missing or wrong in step 5 |
| GitHub Actions shows a red ✗ | **Actions** tab → click the run → usually `DIRECT_DATABASE_URL` |
| `/api/health` doesn't load | Database address wrong, or Supabase project paused |
| Balances look wrong | Run the `sum(balance)` check in step 8 **before** taking more payments |
