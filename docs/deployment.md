# Deployment

## Requirements

- Node 22+
- PostgreSQL 14+ (developed and tested against 16)
- A host that runs a Node server process

## Choosing a runtime

**This application needs a Node runtime with a real TCP connection to Postgres.**
That is not a preference; it is what the correctness guarantees are built on:

- Checkout takes `SELECT … FOR UPDATE` row locks and holds them for the length
  of a transaction. That requires a session pinned to one Postgres backend.
- The ledger's sum-to-zero rule is a `DEFERRABLE INITIALLY DEFERRED` constraint
  trigger, checked at `COMMIT`.
- Password and PIN hashing uses `node:crypto` scrypt at N=32768, which allocates
  32MB per call.

### Cloudflare Workers is not a supported target

Workers is a V8 isolate runtime, not Node. `pg` cannot open a TCP socket there,
`node:crypto`'s scrypt is not dependable under `nodejs_compat`, and the
Next.js adapter story lags the version this app is built on. Getting it running
would mean replacing the database driver and the password hashing — the two
pieces least worth rewriting under time pressure.

**Do not put this on Cloudflare D1.** D1 is SQLite. It has no deferrable
constraint triggers, no `SELECT … FOR UPDATE`, and no advisory locks. Every
integrity guarantee in this codebase — and every concurrency test that proves
them — depends on features D1 does not have. Migrating to D1 does not weaken the
financial model; it removes it.

Cloudflare is still the right front door. See below.

### Recommended shape

```
  Users ──► Cloudflare (DNS, TLS, WAF, DDoS)
              │
              ▼
        Node container  ──►  Managed Postgres
        (Railway / Fly / Render)   (same region)
```

**Co-locate the app and the database in the same region.** This is a throughput
requirement, not a nicety. Every checkout holds row locks across several
statements; cross-region latency multiplies the lock hold time, and the queue at
the busiest bar is exactly where that shows up.

## Environment

```bash
DATABASE_URL=postgres://user:pass@host:5432/cashless
APP_SECRET=$(openssl rand -base64 48)   # 32+ chars. Signs QR payloads.
APP_ORIGIN=https://events.example.com   # CSRF origin allowlist, comma-separated
TRUSTED_PROXY=cloudflare                # cloudflare | forwarded | none
NODE_ENV=production
NEXT_PUBLIC_ENABLE_NFC_SIMULATOR=false  # compiled in at BUILD time, not read at boot
```

Optional tuning:

```bash
DB_POOL_MAX=20                # raise for many concurrent terminals
DB_STATEMENT_TIMEOUT_MS=15000 # checkout holds row locks; do not remove this
```

`APP_SECRET` must be stable across instances and deploys: rotating it
invalidates every outstanding QR code. It never reaches the browser.

`NEXT_PUBLIC_ENABLE_NFC_SIMULATOR` is inlined into the client bundle when the
image is built. Setting it at runtime does nothing. The Dockerfile defaults it
to `false` and only a deliberate `--build-arg` turns it on.

### TRUSTED_PROXY is a security setting

Rate limits key off the client IP, and the client IP comes from a request
header. `X-Forwarded-For` can be set by anything that can reach the origin, so
an attacker who can reach it directly gets a fresh rate-limit bucket per
request and the login limiter stops existing.

| Value | Reads | Use when |
|---|---|---|
| `cloudflare` | `CF-Connecting-IP` only | Behind Cloudflare **and** the origin is locked to Cloudflare |
| `forwarded` | First `X-Forwarded-For`, then `X-Real-IP` | Behind exactly one reverse proxy with no public path around it |
| `none` | nothing | Directly exposed |

Setting `cloudflare` without locking the origin is worse than useless: an
attacker who reaches the origin directly can set `CF-Connecting-IP` themselves.
Lock the origin first.

When no IP can be established the login route skips the per-IP limit rather than
bucketing everyone under a shared key — a shared bucket would let one attacker
exhaust it and lock every cashier out mid-event. The per-email limit and the
account lockout still apply.

## Cloudflare configuration

1. **DNS** — record for your hostname pointed at the origin, proxied (orange
   cloud on).
2. **SSL/TLS mode: Full (strict).** Managed hosts issue a valid certificate, so
   there is no reason to accept anything weaker.
3. **Lock the origin.** Pick one, in order of preference:
   - **Cloudflare Tunnel** — the origin has no public inbound listener at all.
     Strongest, and it removes the whole class of bypass.
   - **Authenticated Origin Pulls** (mTLS) — origin rejects any connection not
     presenting Cloudflare's client certificate.
   - **IP allowlist** — origin firewall accepts only Cloudflare's published
     ranges. Weakest of the three; the ranges change.
4. **Cache rule: bypass cache for `/api/*`.** Never serve a cached balance.
   `/_next/static/*` is content-hashed and immutable — let that cache.
5. **Turn off Rocket Loader.** It reorders script execution and breaks React
   hydration.
6. Set `APP_ORIGIN` to the public HTTPS origin and `TRUSTED_PROXY=cloudflare`.

## Release process

Migrations are a **release step, not a boot step**. A container that migrates on
start races its own replicas and turns a rollback into a schema change.

```bash
npm run db:migrate    # release command — run once per deploy
npm run start         # container command
```

`scripts/migrate.mjs` takes a Postgres advisory lock before applying anything,
so if two instances run it at once, the second waits and then finds nothing to
do. Without that lock, concurrent migrators crash on duplicate DDL — verified,
not assumed.

Deploy order that avoids downtime (all current migrations are additive):

1. Apply migrations.
2. Deploy the new application version.

`npm run db:generate` produces a migration from schema changes; review the SQL
before committing it. Custom SQL — triggers, sequences, views — goes in a
`--custom` migration, as `0001_integrity_rules.sql` does.

## Container

```bash
docker build -t cashless:latest .
docker run --rm -e DATABASE_URL=… cashless:latest npm run db:migrate
docker run -p 3000:3000 -e DATABASE_URL=… -e APP_SECRET=… cashless:latest
```

The image runs as a non-root user and its health check performs a real database
round trip — a container that cannot reach Postgres reports unhealthy rather
than accepting taps it cannot honour.

`docker-compose.yml` brings up Postgres, the migration step and the app together
for the soft test described below.

## Card readers: settle this before event day

The POS accepts taps from USB readers in keyboard-wedge mode
(`components/nfc/readers.ts`). Four things have to be true, and none of them are
visible from the code:

- **The reader must send Enter after the value.** The wedge listener commits on
  `Enter`. A reader configured for Tab, CR+LF, or no terminator produces
  silence, not an error.
- **Inter-character delay must be minimal.** A gap over 120ms is treated as the
  start of a new scan, so a slow reader emits fragments that never resolve.
- **Keyboard layout must be US.** Wedge readers emulate US keystrokes. On
  another layout the hex letters in a UID arrive as different characters.
- **Focus matters.** Taps are ignored while focus is in a text field, so
  cashiers must not leave the cursor in the search box.

### The UID decision

Most inexpensive USB wedge readers emit the **card UID**, not the token written
to the chip. `allowUidOnlyResolution` **defaults to `false`**, so out of the box
those taps are refused. You have two options:

- **Encode tokens onto the cards** and use readers that read the NDEF text
  record. Strongest: the credential is a 256-bit server-issued secret, stored
  hashed, and revocable. Requires reader hardware that does more than UID.
- **Enable `allowUidOnlyResolution`.** Everything works with cheap readers, and
  you accept that a UID is clonable by any phone — a cloned card can spend the
  real card's balance.

If you choose UID-only, the mitigations that still apply are: clone detection
from the `card_taps` history, instant revocation from `/admin/cards`, and the
fact that balances live server-side — a clone can spend a wallet, it can never
create points. Decide this deliberately and write it down; do not discover it at
the first bar.

## Soft test before going live

Do not let event night be this system's first real traffic. The failures that
bite are configuration and hardware, and no test suite catches them.

```bash
cp .env.example .env.docker    # set APP_SECRET and APP_ORIGIN
docker compose up --build -d db
docker compose run --rm migrate
docker compose up --build -d app
```

Then, on the real deployed stack, with the real readers:

- [ ] Tap a real card on a real reader and see it resolve
- [ ] Complete a purchase, then refund it
- [ ] Confirm `sum(balance) = 0` afterwards
- [ ] Pull the network on a terminal mid-checkout and confirm the retry queue
      settles to exactly one charge
- [ ] Sign in as a cashier and confirm they cannot reach admin screens

Twenty people for an hour is enough. Same stack, same database, low stakes.

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

- [ ] `NEXT_PUBLIC_ENABLE_NFC_SIMULATOR=false` **in the built image**
- [ ] `APP_SECRET` set, unique, and backed up
- [ ] `TRUSTED_PROXY` matches the actual topology, and the origin is locked to
      Cloudflare if it is set to `cloudflare`
- [ ] `APP_ORIGIN` is the public HTTPS origin
- [ ] Migrations applied; `sum(balance) = 0` on the live database
- [ ] Reader terminator, delay and keyboard layout verified on real hardware
- [ ] UID-only resolution decided deliberately, either way
- [ ] Settings reviewed: `maxSingleTopUp`, `approvalThreshold*`,
      `allowTransfers`, `allowUidOnlyResolution`, `offlinePosEnabled`
- [ ] Cards written and assigned; batch tokens destroyed after writing
- [ ] Terminals registered and heartbeating
- [ ] Cashiers assigned to their stores only
- [ ] `/admin/ops` on a screen the operations team can see
- [ ] Backup restore rehearsed
- [ ] Soft test completed on the live stack
