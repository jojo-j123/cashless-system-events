# Vercel + Supabase deployment

> **Not a developer?** Use [setup-click-by-click.md](./setup-click-by-click.md)
> instead — same result, done entirely in a browser, no commands to type.
> This document is the engineering reference for the same deployment.

This is the active deployment path: the Next.js app on Vercel, Postgres on
Supabase, both in Frankfurt.

For the container path (Railway / Fly / Render), see
[railway-setup.md](./railway-setup.md). That shape is architecturally sturdier
under sustained load — see [Trade-offs](#trade-offs-you-are-accepting) below for
what you give up here and when it would start to matter.

## What already exists

| Thing | Value |
|---|---|
| Supabase project | `cashless-system-events` |
| Project ref | `odovefouvbjsixklarhv` |
| Region | `eu-central-1` (Frankfurt) |
| Cost | $0/month (free tier) |
| Dashboard | https://supabase.com/dashboard/project/odovefouvbjsixklarhv |

The database is **created but empty**. Migrations are applied by GitHub Actions
(step 4), not by hand — see [Why migrations run in
CI](#why-migrations-run-in-ci).

Vercel function region is pinned to `fra1` in `vercel.json`, which is the same
city as the database. Do not change one without the other: every checkout holds
row locks across several statements, and putting a continent between the app and
the database multiplies the lock hold time at the busiest bar.

## Setup

### 1. Install the Vercel GitHub App

https://github.com/apps/vercel → grant access to `cashless-system-events`.

Without this, Vercel cannot link the repository and there is no deploy on push.

### 2. Import the project into Vercel

https://vercel.com/new → select `jojo-j123/cashless-system-events` → Import.

Team: **Nile Digital**. Do not deploy yet — it will fail without the environment
variables in step 3. A failed first deploy is harmless; it just wastes a cycle.

### 3. Environment variables (Vercel → Settings → Environment Variables)

Get both connection strings from
**Supabase → Connect** (top of the dashboard):

| Variable | Value | Notes |
|---|---|---|
| `DATABASE_URL` | Connect → **Transaction pooler** (port `6543`) | Runtime. Correct for serverless. |
| `APP_SECRET` | generate — see below | Signs QR payloads. **Back it up.** |
| `APP_ORIGIN` | `https://<your-vercel-domain>` | CSRF allowlist. Update when you add a custom domain. |
| `TRUSTED_PROXY` | `forwarded` | Vercel is the single proxy. Use `cloudflare` **only** after locking the origin. |
| `NEXT_PUBLIC_ENABLE_NFC_SIMULATOR` | `false` | Compiled in at build time. Must be false in production. |

Generate `APP_SECRET` yourself — do not let anyone generate it into a chat log
or a ticket:

```bash
openssl rand -base64 48                      # macOS / Linux / Git Bash
```
```powershell
[Convert]::ToBase64String((1..48|%{Get-Random -Max 256}))   # PowerShell
```

`APP_SECRET` must be identical across every deploy and instance. Rotating it
invalidates every outstanding QR code, so store it somewhere you will still have
it on event day.

You do **not** need to set `DB_POOL_MAX`. The app detects Vercel and defaults to
one connection per instance, which is what a pooled serverless deployment wants.

### 4. GitHub secret for migrations

**GitHub → Settings → Secrets and variables → Actions → New secret**

| Secret | Value |
|---|---|
| `DIRECT_DATABASE_URL` | Supabase → Connect → **Session pooler** (port `5432`) |

This must be the **session** pooler, not the transaction pooler. See below.

### 5. Merge to main

The workflow runs `npm run verify`, then applies migrations. Vercel builds and
deploys in parallel off the same push.

### 6. Confirm it is actually alive

```bash
curl https://<your-vercel-domain>/api/health
```

That endpoint does a real database round trip, so a 200 means the app reached
Postgres — not merely that a process is running.

Then prove the ledger invariant holds on the live database
(Supabase → SQL Editor):

```sql
SELECT sum(balance) FROM accounts;              -- must be exactly 0
SELECT * FROM account_reconciliation WHERE drift <> 0;  -- must be empty
```

## Why migrations run in CI

Two reasons, and both are about the advisory lock in `scripts/migrate.mjs`.

**Not on boot.** A serverless function that migrated on cold start would run the
migrator from every instance that spins up. The advisory lock would hold the
line, but the right fix is not to create the stampede in the first place.

**Not through the transaction pooler.** `pg_advisory_lock` is *session*-scoped.
A transaction-mode pooler (`:6543`) returns the session to the pool between
statements, so the lock is taken and dropped immediately. Two concurrent
migrators would then interleave DDL while both believed they held it — and that
failure is silent, which makes it the worst kind. `migrate.mjs` therefore
prefers `DIRECT_DATABASE_URL` and the workflow points it at the **session**
pooler (`:5432`), which keeps session state.

Supabase's true direct host (`db.<ref>.supabase.co`) is IPv6-only and GitHub's
runners are IPv4, so the session pooler is the correct target here rather than a
compromise.

## The public API surface, and why it is closed

Supabase publishes the `public` schema over an auto-generated REST API, and
pre-grants every newly created table to an `anon` role whose API key is public
by design. On a fresh project the default privilege for a table created by
`postgres` is `arwdDxtm` to `anon` — INSERT, SELECT, UPDATE and DELETE, to
unauthenticated callers.

For a typical CRUD app that is the product, paired with RLS policies. Here it
would be a hole straight through the financial model. Every guarantee in this
codebase assumes writes arrive through the application: the double-entry ledger,
the `FOR UPDATE` locks, idempotency, two-person approval. And `accounts.balance`
carries no append-only trigger — only the ledger, audit, inventory-movement and
card-event tables do — so a direct `UPDATE accounts SET balance = …` over that
REST endpoint would set any wallet to any number, with the ledger none the wiser.

`0002_lock_down_public_schema.sql` closes it: row-level security on every table
in `public` with no policies (deny-all for any role lacking `BYPASSRLS`), plus
revoking the `anon` and `authenticated` grants, present and future. The
application connects as `postgres`, which has `BYPASSRLS` on Supabase — checked
against `pg_roles`, not assumed — so it is unaffected.

Verified against a real database rather than reasoned about: a role granted
`ALL` privileges but lacking `BYPASSRLS` reads **0 rows**, its
`UPDATE accounts SET balance = 999999` reports `UPDATE 0`, and its `INSERT` is
refused with `new row violates row-level security policy`. The owner sees its
data normally throughout.

The migration is a no-op on plain Postgres — local development, CI, a container
deployment — where `anon` and `authenticated` do not exist.

> **Adding a table later?** RLS is off by default on a new table, so any future
> migration that creates one in `public` must also
> `ALTER TABLE public.<name> ENABLE ROW LEVEL SECURITY;`. Supabase's security
> advisor flags a missed one, but treat that as the backstop, not the plan.

## Trade-offs you are accepting

The transaction pooler is genuinely fine for the application's correctness. Every
money path runs inside one transaction, and a transaction-mode pooler pins one
backend for that transaction's whole life — so `SELECT … FOR UPDATE` row locks
and the `DEFERRABLE INITIALLY DEFERRED` sum-to-zero trigger behave exactly as
they do on a direct connection. Nothing in the financial model is weakened.

What you actually give up versus a container:

- **Cold starts.** An idle deployment takes ~1–3s on the first tap. Noticeable in
  a queue, not fatal. Sustained traffic keeps instances warm.
- **Connection ceiling under burst.** Serverless concurrency is the thing that
  scales, and each instance takes a pooler slot. The free tier's pooler is the
  first thing that will break if you outgrow this.
- **Function timeout.** A checkout killed at the platform limit drops its
  connection, and Postgres rolls the transaction back. That is a *failed*
  checkout, never a partial one — the integrity model holds — but the cashier
  sees an error.

If you outgrow the free tier: raise the Supabase plan first (the pooler is the
bottleneck, not Vercel), and move to the container shape in
[railway-setup.md](./railway-setup.md) if cold starts become a complaint.

## Custom domain and Cloudflare

`*.vercel.app` is fine for a soft test. For the event, put a real domain on it:

1. Vercel → Settings → Domains → add your domain.
2. Update `APP_ORIGIN` to that HTTPS origin and redeploy — CSRF checks read it.
3. Only if you front it with Cloudflare: lock the origin first (Authenticated
   Origin Pulls or an IP allowlist), *then* set `TRUSTED_PROXY=cloudflare`.
   Setting it without locking the origin is worse than leaving it alone —
   anyone who reaches the origin directly can set `CF-Connecting-IP` themselves
   and mint a fresh rate-limit bucket per request.

See [deployment.md](./deployment.md#cloudflare-configuration) for the full
Cloudflare setup.

## Before event day

The deployment being green is not the same as the system being ready. The
failures that actually bite are hardware and configuration, and no test suite
catches them — work the reader constraints and the soft-test checklist in
[deployment.md](./deployment.md#card-readers-settle-this-before-event-day).
