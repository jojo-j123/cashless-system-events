# Architecture

## 1. Purpose and non-goals

This system runs the cashless economy of a live event. Participants hold an NFC card,
staff issue **points**, and participants spend those points at event stores.

Points are treated as **money**. Everything below follows from that single decision:
an append-only double-entry ledger, ACID transactions, idempotency, RBAC enforced on the
server, and an append-only audit trail.

**Non-goals (deliberate):**

- No real-money payment processing. "Top-up" means *an authorised staff member issued
  points*. A real payment provider, if ever needed, plugs in as a separate service that
  calls `TopUpService` after settlement. It is not woven through the ledger.
- No unbounded offline spending. See §9.

## 2. Stack

| Layer | Choice | Why |
| --- | --- | --- |
| Runtime | Node 22 | LTS, stable `node:crypto` primitives |
| App | Next.js 16 (App Router), React 19, TypeScript strict | One deployable for UI + API; server components keep balances off the client |
| DB | PostgreSQL 16 | Row locking, real transactions, CHECK constraints, `LISTEN/NOTIFY` |
| Data access | Drizzle ORM + drizzle-kit | SQL-first, fully typed, does not hide `FOR UPDATE` or transactions |
| Validation | Zod | One schema shared by API validation and TS types |
| Auth | Opaque session tokens in httpOnly cookies, scrypt password hashing | No JWT revocation problem; no native build dependencies |
| Realtime | SSE + Postgres `LISTEN/NOTIFY` | Works behind serverless/edge proxies; multi-instance safe |
| Tests | Vitest against a real Postgres database | Concurrency bugs do not reproduce against mocks |

**No vendor lock-in.** The schema is plain SQL and runs on Neon, Supabase, RDS, or a
self-hosted box unchanged.

## 3. Layering

```
app/            React server + client components. No business logic. No SQL.
  api/          Route handlers: authn, authz gate, Zod parse, call service, map errors.
lib/
  services/     ALL business rules. The only place that writes to the ledger.
  db/           Drizzle schema, migrations, connection pool.
  auth/         Sessions, password/PIN hashing, CSRF.
  authz/        Permission catalogue + server-side enforcement.
  nfc/          Card credential abstraction (server side).
  errors/       Typed domain errors -> HTTP status + human message.
components/
  nfc/          NFCReader implementations (Web NFC, keyboard-wedge, simulator).
```

**Rule that is enforced by review, not convention:** a React component never computes a
price, a balance, or an authorisation outcome. It renders what the server returned.

## 4. The ledger

`users.balance` is *not* the source of truth. It does not exist as a standalone concept.

Every point movement is a **double-entry transaction**: a header row plus two or more
entry rows whose signed amounts sum to exactly zero. This is enforced by a database
trigger, not by hope.

### Accounts

| Account type | Owner | Meaning |
| --- | --- | --- |
| `USER_SPENDABLE` | user | A participant's wallet. What they can spend. |
| `TEAM_SPENDABLE` | team | Optional shared team wallet. |
| `TEAM_SCORE` | team | Competition score. **Separate ledger, not spendable.** |
| `USER_SCORE` | user | Individual competition score. |
| `SYSTEM_ISSUANCE` | event | The mint. Goes negative as points are issued. |
| `SYSTEM_STORE_REVENUE` | store | Points collected by a store. |
| `SYSTEM_FORFEITURE` | event | Points removed by adjustment/expiry. |

Issuing 500 points to Ahmed:

```
SYSTEM_ISSUANCE   -500
ahmed USER_SPENDABLE +500
                  -----
                     0
```

Ahmed buying a 300-point burger:

```
ahmed USER_SPENDABLE -300
food_court REVENUE   +300
                     -----
                        0
```

**Consequence: for any event, the sum of all account balances is exactly zero, always.**
That is a single SQL query, it is asserted in the test suite, and it means "points in
circulation" is a proven number rather than an estimate. This is the whole reason for
double entry.

### Team points: two distinct things

The spec asked whether team points are a shared wallet or a score. The answer is both,
and they are **different accounts with different ledgers**:

- `TEAM_SPENDABLE` — a real wallet. A team manager can spend it, if enabled.
- `TEAM_SCORE` — leaderboard only. Spending never reduces it. Awarding it never creates
  spendable value (it is balanced against `SYSTEM_ISSUANCE` on a score-only sub-ledger).

Allocating to a team can optionally fan out to members' personal wallets; that is an
explicit `distribution` mode on the allocation, not an implicit side effect.

### Materialised balances

`accounts.balance` is a materialised column updated inside the same transaction as the
entry that changed it, under a row lock. It is a cache with a **provable** relationship
to the ledger: `balance == SUM(entries.amount)`. A reconciliation query asserts this and
is covered by tests. Reads are fast; correctness does not depend on the cache, because
every write re-reads under `FOR UPDATE`.

### Immutability

`ledger_transactions` and `ledger_entries` have `BEFORE UPDATE OR DELETE` triggers that
raise an exception. Correcting a mistake means writing a compensating `REVERSAL` or
`REFUND` transaction that references the original. History is never edited.

## 5. Concurrency and the money path

A purchase is the hot path and the dangerous one. It runs in one `READ COMMITTED`
transaction with explicit row locks acquired in a **globally fixed order** to make
deadlock structurally impossible:

```
BEGIN
  1. Claim the idempotency key (INSERT .. ON CONFLICT DO NOTHING)
  2. SELECT accounts     WHERE id = ANY($ids) ORDER BY id FOR UPDATE
  3. SELECT inventory    WHERE id = ANY($ids) ORDER BY id FOR UPDATE
  4. Re-read prices from the DB   <- never trust the client's totals
  5. Assert balance >= total, assert stock >= qty, assert card ACTIVE
  6. INSERT purchase (PENDING) + purchase_items
  7. INSERT ledger_transaction + entries; UPDATE account balances
  8. UPDATE inventory; INSERT inventory_movements
  9. UPDATE purchase -> COMPLETED
 10. INSERT audit_log
COMMIT
```

Order: **accounts before inventory**, each ascending by id. Any failure rolls back the
whole thing, including the point deduction. There is no partial purchase.

Guarantees this buys us:

- **No double spend.** Two concurrent checkouts on one wallet serialise on the account
  row lock; the second sees the first's committed balance.
- **No oversell.** Same, on the inventory row, plus `CHECK (quantity_on_hand >= 0)` as a
  last line of defence at the storage layer.
- **No negative balance.** `CHECK (balance >= 0)` on accounts that disallow it, plus an
  application check that returns a clean error first.
- **No duplicate purchase.** Idempotency key claimed inside the same transaction.

## 6. Idempotency

Every mutating money endpoint requires an `Idempotency-Key` header.

The key is stored with a hash of the request body. Replaying an identical request returns
the **original stored response**, byte for byte, and creates nothing. Replaying a
*different* body under the same key is a `409`, because that is a client bug and silently
picking one is worse than failing loudly. A key claimed by an in-flight request returns
`409 request_in_progress`.

This is what makes the POS safe to retry on a flaky event network, which is the actual
operational problem at a festival.

## 7. NFC

**The card carries an identifier. It never carries a balance.** See `docs/nfc.md`.

Resolution is always: credential -> `CardService.resolveCard()` -> server-side lookup ->
status check -> account. The card is an *index into the database*, never an authority.

The client-side reader is an interface with three implementations (Web NFC, USB
keyboard-wedge, dev simulator) that all emit the same `CardCredential` and hit the same
endpoint. The simulator is not a bypass: it produces a real credential and goes through
the identical server path.

## 8. Authorisation

RBAC with a fixed permission catalogue (`lib/authz/permissions.ts`). Roles are bundles of
permissions; some grants are scoped to a store (a cashier at Store A is not a cashier at
Store B).

Every API route declares its required permission and the gate runs **before** the handler
body. The UI hides what you cannot do, but hiding is cosmetic — the server is the control.
There is a test that asserts a cashier session is rejected by every admin endpoint.

## 9. Offline behaviour — the honest answer

Signed offline transactions with local queues cannot prevent double-spend during a real
network partition. A card can be tapped at two offline terminals and both will approve.
The only fixes are pre-authorised holds or accepting loss up to a cap.

**Default: offline purchases are disabled.** `offline_pos_enabled = false`,
`offline_spend_cap = 0`.

What is built instead, and what actually solves the real problem:

- Terminal identity and registration, with heartbeats and health status.
- A **durable client-side retry queue**: a submitted purchase keeps its idempotency key
  and replays until the server confirms. Brief drops — the common failure — become
  invisible, and replay can never double-charge.
- Clear `ONLINE / OFFLINE / SYNCING / ERROR` state on the POS.
- The cap and flag exist in settings, so enabling bounded offline spending later is a
  config change plus a signature check, not a rewrite.

Shipping unbounded offline spending would be trading a guaranteed correctness property
for a rare convenience. Not worth it.

## 10. Multi-event

Every domain table carries `event_id`. There is no global "current event" constant.
Uniqueness is scoped per event, so the same person can hold a card at Event A and Event B
with independent wallets. Settings, teams, stores, products and ledgers are all
event-scoped.

## 11. Failure handling

Domain errors are typed (`InsufficientFunds`, `CardSuspended`, `OutOfStock`, ...) and carry
a machine `code`, an HTTP status, and a message written for a cashier under time pressure.
Unexpected errors log with a correlation id server-side and return a generic message.
Stack traces and SQL never reach a client.
