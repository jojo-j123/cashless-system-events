# Security

Points are internal currency, not money — but the failure modes are identical
to money, so the system is built as though they were.

## Authentication

- **Passwords**: scrypt (`N=32768, r=8, p=1`, 64-byte key, 16-byte random salt),
  parameters stored with the hash so they can be raised later without
  invalidating existing passwords. Chosen over argon2/bcrypt specifically to
  avoid a native build step, which is a real deployment failure mode.
- **Sessions**: opaque 256-bit random tokens in `httpOnly; SameSite=Lax; Secure`
  cookies, stored only as SHA-256 hashes. A database leak does not hand out live
  sessions. Revocation is immediate — there is no JWT expiry window to wait out.
- **Enumeration**: every login failure returns one message, and a missing
  account still spends comparable time verifying a dummy hash, so "no such user"
  is not detectable by timing.
- **Lockout**: 8 failed attempts locks an account for 15 minutes; IP and email
  are independently rate limited before the database is touched at all.
- **Staff PIN**: a second factor for high-value counter top-ups, hashed with the
  same scrypt parameters — the keyspace is small, so a fast hash would be
  trivially brute-forced from a leak.

## Authorisation

RBAC with a fixed permission catalogue. Route handlers require *permissions*,
never roles, so adding a role never touches a route.

Grants are scoped: a cashier at Store A holds no authority at Store B, and an
admin of Event A holds none at Event B. This is checked by `Actor.can()` against
the grant's own scope, and it is covered by tests that assert a cashier is
rejected by every points-creating endpoint.

**Server-side always.** The UI hides what a user cannot do, but hiding is
cosmetic. Every permission check runs in the route wrapper *before* the handler
body, so a route physically cannot forget one.

Separation of duties, enforced:
- Only `SUPER_ADMIN` can grant roles — an admin cannot promote themselves.
- A cashier can take payment and refund, but cannot create points or change a
  price.
- Two-person control on high-value operations, with the requester barred from
  approving, both in code and by a `CHECK` constraint.

## Request security

| Control | Implementation |
| --- | --- |
| CSRF | Double-submit token: a readable cookie that must be echoed in `x-csrf-token`. A cross-site post can carry the cookie but cannot read it. |
| Origin | `Origin` checked against `APP_ORIGIN` on every mutation. |
| SQL injection | Parameterised queries throughout (Drizzle). The three places an id reaches SQL text — for `ORDER BY … FOR UPDATE` — validate UUID shape first. |
| XSS | React escapes by default. The one `dangerouslySetInnerHTML` renders a server-generated QR SVG from a library, with no user input in it. |
| Headers | CSP, `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`. |
| Rate limiting | Fixed-window counters in Postgres, so limits hold across app instances rather than per process. |
| Error leakage | Domain errors return a written message; anything unexpected is logged server-side with a correlation id and returns a generic 500. No stack traces or SQL reach a client. |

## Financial integrity

1. **Double-entry.** Every transaction's legs sum to zero, enforced by a
   deferred constraint trigger. Consequently the sum of all accounts in an event
   is exactly zero, always — so "points in circulation" is a proven number, not
   an estimate.
2. **Append-only.** Ledger, audit, inventory movements and card events reject
   `UPDATE` and `DELETE` at the database level.
3. **ACID.** Every money operation is one transaction. Any failure rolls back
   everything, including the audit entry, so the log can never disagree with
   reality.
4. **Row locks in a fixed global order** — accounts before inventory, each
   ascending by id — which makes deadlock structurally impossible rather than
   merely unlikely.
5. **Idempotency.** The key is claimed inside the same transaction as the work,
   so there is no window where the work committed but the key did not.
6. **Constraints as backstop.** Non-negative balances and stock are `CHECK`
   constraints, not just application checks.

## Secrets

Everything sensitive comes from environment variables and never reaches the
browser: `DATABASE_URL`, `APP_SECRET`. The only `NEXT_PUBLIC_` variable is the
simulator flag, which is a feature toggle, not a secret.

Card tokens and terminal API keys are shown exactly once, at creation, and
stored only as hashes. They cannot be recovered — by design.

Audit entries frequently capture whole rows, so a redaction pass strips any
field whose name looks like a credential before it is written. The audit log
must never become the softest place to steal a secret.

## Threat notes

**A compromised cashier account** can take payments and issue refunds at its own
store. It cannot create points, change prices, read the ledger, or touch another
store. Every action it takes is attributed and immutable.

**A compromised admin account** is serious: it can issue points and suspend
cards. It cannot grant itself more roles, cannot exceed the configured single
top-up limit, cannot approve its own high-value requests, and cannot erase what
it did.

**A stolen database dump** yields no usable passwords (scrypt), no live sessions
(hashed tokens), and no working cards (hashed tokens).

## Known limitations

- No MFA beyond the staff PIN. TOTP is the obvious next step for admin accounts.
- Rate limiting is fixed-window, so a burst can straddle a boundary. A sliding
  window is the upgrade if abuse becomes real.
- The realtime bus is in-process; multi-instance deployments need the
  `LISTEN/NOTIFY` bridge described in `lib/core/events-bus.ts`.
- Session cookies are `SameSite=Lax`, which is correct for this app's flows but
  would need review before embedding any surface in a third-party page.
