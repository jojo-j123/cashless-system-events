# Railway Secrets Setup

This file documents which secrets must be set in Railway and GitHub Actions. **Do not commit actual secret values.**

## Railway Environment Variables (production)

Set these in **Railway Project Settings → Variables**:

| Variable | Example | Notes |
|----------|---------|-------|
| `DATABASE_URL` | `postgres://user:pass@db.railway.internal:5432/cashless` | Auto-populated if using Railway Postgres |
| `NODE_ENV` | `production` | Required for Next.js |
| `PORT` | `3000` | Railway sets this automatically; app reads it |
| `APP_SECRET` | `base64(32+ bytes)` | **Generate once, back it up, never rotate without invalidating QR codes** |
| `APP_ORIGIN` | `https://events.example.com` | Public HTTPS origin for CSRF allowlist, comma-separated if multiple |
| `TRUSTED_PROXY` | `cloudflare` | Set to `cloudflare` if behind Cloudflare; `none` if Railway domain used directly |
| `DB_POOL_MAX` | `20` | Raise for many concurrent terminals; `max_connections` on Postgres must be higher |
| `DB_STATEMENT_TIMEOUT_MS` | `15000` | Checkout holds row locks; do not remove |
| `NEXT_PUBLIC_ENABLE_NFC_SIMULATOR` | `false` | Compiled at build time; must be false in production |

## GitHub Actions Secrets

Set these in **GitHub Settings → Secrets and variables → Actions**:

| Secret | Source | Usage |
|--------|--------|-------|
| `RAILWAY_TOKEN` | Railway Account Settings → API Tokens | Authenticates `railway` CLI to deploy |
| `RAILWAY_PROJECT_ID` | Railway dashboard (visible in URL or via `railway whoami`) | Identifies which project to deploy to |

## Getting These Values

### Railway Token

```bash
railway login
railway whoami  # Shows account and project info
# Then go to account settings for API token
```

### Project ID

Visible in Railway dashboard URL: `https://railway.app/project/<PROJECT_ID>`

Or via CLI:
```bash
railway link
railway whoami
```

## First-Time Setup Checklist

- [ ] Create Railway project and Postgres database
- [ ] Generate `APP_SECRET`: `openssl rand -base64 48`
- [ ] Set all variables in Railway dashboard
- [ ] Create `RAILWAY_TOKEN` and `RAILWAY_PROJECT_ID` in GitHub Secrets
- [ ] Push to `main` and watch first deployment
- [ ] Verify app boots: `curl https://your-railway-domain/api/health`
- [ ] Verify database: `SELECT sum(balance) FROM accounts;` → should be 0

## Important: APP_SECRET Rotation

If you ever need to rotate `APP_SECRET`:

1. Every outstanding QR code becomes invalid
2. Cashiers will get 403 on `/api/qr/<token>`
3. Attendees holding digital wallets in QR must re-request

**Do not rotate casually.** Only rotate if leaked. Back it up on first generation.

## Cloudflare Integration

If using Cloudflare as front door:

1. Set `TRUSTED_PROXY=cloudflare`
2. Lock origin to Cloudflare (Tunnel, mTLS, or IP allowlist)
3. Set `APP_ORIGIN` to your Cloudflare domain (not railway.app subdomain)

Without origin lock, setting `TRUSTED_PROXY=cloudflare` is worse than useless — an attacker reaching the Railway container directly can set `CF-Connecting-IP` themselves.
