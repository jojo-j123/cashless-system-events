# Railway Deployment

This guide walks through setting up the cashless system on Railway with a managed Postgres database and GitHub Actions auto-deployment.

## Prerequisites

- Railway account (https://railway.app)
- GitHub repository with push access
- This codebase

## Step 1: Create Railway Project

1. Go to https://railway.app/dashboard
2. New Project → Empty Project
3. Name it `cashless-system` (or your preference)

## Step 2: Add PostgreSQL

From project dashboard:

1. **Add Service** → **Database** → **PostgreSQL**
2. Railway creates the database and connection string automatically
3. From **Postgres** service card, click Variables
4. Note the connection string (appears as `DATABASE_URL` in the service)

## Step 3: Configure Environment Variables

In the Railway project dashboard:

1. **Project Settings** → **Environment Variables**
2. Add these variables for production environment:

   ```
   DATABASE_URL=postgres://...  # copy from Postgres service variables
   NODE_ENV=production
   PORT=3000
   APP_SECRET=<generate with: openssl rand -base64 48>
   APP_ORIGIN=https://<your-domain.com>
   TRUSTED_PROXY=cloudflare
   DB_POOL_MAX=20
   DB_STATEMENT_TIMEOUT_MS=15000
   NEXT_PUBLIC_ENABLE_NFC_SIMULATOR=false
   ```

   **Do not** commit these to the repository. Railway injects them at runtime.

## Step 4: Connect GitHub for Auto-Deployment

### Option A: Railway CLI (Recommended)

```bash
# Install CLI
npm install -g @railway/cli

# Login
railway login

# Link to your project
railway link

# Get your project ID and token for GitHub Actions
railway whoami  # shows project info
```

### Option B: GitHub Actions Secrets

1. In **GitHub repo Settings** → **Secrets and variables** → **Actions**
2. Create these secrets:

   ```
   RAILWAY_TOKEN=<your-railway-token>
   RAILWAY_PROJECT_ID=<your-project-id>
   ```

   Get these from Railway dashboard (Account Settings → API Tokens).

## Step 5: First Deploy

Push to `main` branch:

```bash
git push origin main
```

GitHub Actions will:
1. Run `npm run verify` (typecheck, lint, tests, build)
2. Deploy to Railway if verification passes

Monitor in:
- GitHub Actions tab in your repo
- Railway project Deployments tab

## Step 6: Set Up Cloudflare (Recommended)

See [deployment.md](./deployment.md#cloudflare-configuration) for Cloudflare setup. TL;DR:

1. Point DNS to Railway's domain
2. Set SSL/TLS mode to "Full (strict)"
3. Lock origin with Cloudflare Tunnel or IP allowlist
4. Bypass cache for `/api/*`
5. Turn off Rocket Loader

## Monitoring

Railway provides:

- **Deployments**: See build and runtime logs
- **Metrics**: CPU, memory, network graphs
- **Logs**: Real-time JSON logs from the app

The app logs every request with:
```json
{"method":"POST","path":"/api/purchases","status":200,"duration_ms":45,"request_id":"..."}
```

Set up a log aggregator (Datadog, LogRocket, etc.) by pointing Railway's log drain there.

## Rollback

Railway keeps the last 10 deployments. To rollback:

1. Railway dashboard → Deployments
2. Find the working version
3. Click **Redeploy**

No downtime — Railway performs a blue-green swap.

## Soft Test Before Event

Before going live, do a dry run:

```bash
# This deploys to production but with test data
# Verify on the real stack:
# - [ ] Tap a real card, confirm it resolves
# - [ ] Checkout → refund → confirm sum(balance) = 0
# - [ ] Pull network mid-checkout, confirm retry queue settles
# - [ ] Sign in, confirm cashier cannot reach admin

# Then destroy test data and redeploy with seed.sql for real event
```

## Troubleshooting

**App won't start**
- Check logs in Railway Deployments tab
- Common: missing `DATABASE_URL` or migration failed
- Run `npm run db:migrate` locally against production DB to debug

**High latency**
- App and DB must be in same region; verify in Railway dashboard
- Check `DB_POOL_MAX` (default 20); raise for many concurrent terminals

**Deployment fails**
- `npm run verify` failed locally? Fix and re-push
- GitHub Actions log shows which step failed
- Railway logs show runtime errors

## Costs

As of 2025:

- **Postgres**: ~$12/month (5GB included, then $0.24/GB)
- **App**: ~$5/month (512MB RAM, pay per usage after 5 credits)
- **Total**: ~$17/month baseline, scales with usage

For a 1,000–10,000 person event with 100–500 tx/min, you stay well under this.

## Next Steps

1. Push to `main` and watch first deployment
2. Test against staging DB before going live
3. Set up Cloudflare if using event.example.com (not Railway.app subdomain)
4. Configure card readers and run soft test
5. Deploy with production seed on event day
