# Deployment

## Requirements

- Node 22+
- PostgreSQL 14+ (developed and tested against 16)
- Any host that runs a Next.js Node server: Vercel, Fly, Railway, Render, ECS,
  or a plain VM. Nothing here is host-specific.

## Environment

```bash
DATABASE_URL=postgres://user:pass@host:5432/cashless
APP_SECRET=$(openssl rand -base64 48)   # 32+ chars. Signs QR payloads.
APP_ORIGIN=https://events.example.com   # CSRF origin allowlist, comma-separated
NODE_ENV=production
NEXT_PUBLIC_ENABLE_NFC_SIMULATOR=false  # MUST be false in production
```

Optional tuning:

```bash
DB_POOL_MAX=20                # raise for many concurrent terminals
DB_STATEMENT_TIMEOUT_MS=15000 # checkout holds row locks; do not remove this
```

`APP_SECRET` must be stable across instances and deploys: rotating it
invalidates every outstanding QR code. It never reaches the browser.

## First deploy

```bash
npm ci
npm run db:migrate        # applies lib/db/migrations in order
npm run build
npm run start
```

Then create the first event and super admin. `scripts/seed.ts` is the reference
for how to do this through the real services; for production, adapt it rather
than running it — it creates demo participants with a shared password.

## Migrations

Forward-only and idempotent to apply. Deploy order that avoids downtime:

1. Apply migrations (all current ones are additive).
2. Deploy the new application version.

`npm run db:generate` produces a migration from schema changes; review the SQL
before committing it. Custom SQL — triggers, sequences, views — goes in a
`--custom` migration, as `0001_integrity_rules.sql` does.

## Scaling for event day

Sized for 1,000–10,000 participants and hundreds of transactions per minute.

**Database is the bottleneck, and deliberately so** — correctness lives there.

- Connection pool: `DB_POOL_MAX × instances` must stay under the server's
  `max_connections`. At 4 instances × 20 that is 80; leave headroom.
- Contention is per-wallet and per-product row, not global. Two people buying
  different items never block each other. Ten cashiers selling the *last* hoodie
  do serialise — correctly.
- Read replicas are viable for reports and leaderboards. **Never** point the
  checkout path at a replica: it reads balances under `FOR UPDATE`, which
  requires the primary.
- Caching: event settings are cached in-process for 5 seconds. **Balances are
  never cached** — a stale balance is a spending decision made on a lie.

## Health and observability

- `GET /api/health` — liveness plus a real database round trip. Use it as the
  load balancer probe.
- Every request emits one structured JSON log line: method, path, status,
  duration, request id. Point these at your log aggregator; latency percentiles
  and error rates fall out of them directly.
- `/admin/ops` is the live operations screen for the event team: terminals
  online, transactions per minute, failed transactions, low stock, and the
  ledger integrity check.
- Unexpected errors log with a correlation id that is also returned to the
  client, so a report of "it said something went wrong" is traceable to one log
  line.

## Backups

Point-in-time recovery, and test the restore before the event rather than during
it. The ledger is append-only, so a restore to any point yields a consistent
financial position.

Verify integrity any time with:

```sql
SELECT sum(balance) FROM accounts WHERE event_id = '…';  -- must be exactly 0
SELECT * FROM account_reconciliation WHERE drift <> 0;   -- must be empty
```

## Event-day checklist

- [ ] `NEXT_PUBLIC_ENABLE_NFC_SIMULATOR=false`
- [ ] `APP_SECRET` set, unique, and backed up
- [ ] Settings reviewed: `maxSingleTopUp`, `approvalThreshold*`,
      `allowTransfers`, `allowUidOnlyResolution`, `offlinePosEnabled`
- [ ] Cards written and assigned; batch tokens destroyed after writing
- [ ] Terminals registered and heartbeating
- [ ] Cashiers assigned to their stores only
- [ ] `/admin/ops` on a screen the operations team can see
- [ ] Backup restore rehearsed
