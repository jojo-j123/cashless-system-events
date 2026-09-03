# Database

PostgreSQL 16. 43 tables, all event-scoped, all with foreign keys, all with
timestamps. Migrations live in `lib/db/migrations` and are applied with
`npm run db:migrate`.

## The rule that shapes everything

**Financial history is never edited.** `ledger_transactions`, `ledger_entries`,
`audit_logs`, `inventory_movements` and `card_events` have `BEFORE UPDATE OR
DELETE` triggers that raise an exception. A mistake is corrected by writing a
compensating record, not by rewriting the original.

## Table groups

### Identity and access
| Table | Purpose |
| --- | --- |
| `events` | The top-level container. Everything is scoped to one. |
| `event_settings` | Per-event configuration as validated JSON. |
| `users` | People. Global, not per-event: one login across events. |
| `user_profiles` | Optional extra detail. |
| `roles`, `permissions`, `role_permissions` | The RBAC catalogue. |
| `user_roles` | A grant, optionally scoped to an event and/or a store. |
| `sessions` | Opaque session tokens, stored hashed. |
| `event_participants` | Enrolment of a person in an event. |

### Teams
`teams`, `team_members`. One team per person per event, enforced by a unique
index on `(event_id, user_id)` — not by application code.

### Cards
| Table | Purpose |
| --- | --- |
| `nfc_cards` | Identifier only. `token_hash` is the credential; `uid` is the chip serial. |
| `card_events` | Append-only history of every lifecycle action. |
| `card_taps` | Every presentation, resolved or rejected. Drives rate limiting and clone detection. |

A partial unique index enforces at most one `ACTIVE` card per person per event,
so a race between two staff members assigning cards cannot produce two.

### Ledger
| Table | Purpose |
| --- | --- |
| `accounts` | Every place points can sit — wallets and system counterparties. |
| `ledger_transactions` | Transaction header. Append-only. |
| `ledger_entries` | The signed legs. Append-only, must sum to zero. |

`accounts.balance` is a materialised cache. The view `account_reconciliation`
proves it equals the sum of that account's entries; any row with `drift <> 0`
is a bug, and the test suite asserts the view returns none.

### Commerce
`stores`, `store_staff`, `product_categories`, `products`, `inventory`,
`inventory_movements`.

### Transactions
`terminals`, `purchases`, `purchase_items`, `refunds`, `refund_items`.

### Points issuance
`topups`, `topup_batches`, `topup_batch_rows`, `transfers`, `approval_requests`.

### Platform
`audit_logs`, `idempotency_keys`, `rate_limit_buckets`, `notifications`,
`challenges`, `challenge_completions`, `achievements`, `user_achievements`,
`rewards`.

## Constraints that carry real weight

These are not decoration. Each one is the last line of defence for a rule the
service layer also enforces, so a bug in application code cannot corrupt data.

| Constraint | What it prevents |
| --- | --- |
| `accounts_balance_non_negative` | A wallet going below zero |
| `inventory_non_negative` | Overselling |
| `ledger_entries_balance_consistent` | `balance_after ≠ balance_before + amount` |
| `ledger_entries_balanced` (deferred trigger) | An unbalanced transaction committing |
| `ledger_entries_event_scope` | An entry crossing events |
| `purchase_items_line_total` | A line total that is not `price × quantity` |
| `purchases_refunded_within_total` | Refunding more than was paid |
| `approval_requests_two_person` | Approving your own request |
| `transfers_distinct_parties` | Sending points to yourself |
| `nfc_cards_one_active_per_user` | One person holding two live cards |
| `idempotency_keys_scope_key` | Two operations under one key |

## Indexing

Written for the queries that actually run at an event:

- Checkout: `accounts_user_type_key`, `inventory_product_key` — both are unique
  index lookups feeding a `FOR UPDATE`.
- Wallet history: `ledger_entries_account_time_idx` supports keyset pagination
  on `(created_at, id)` without a sort.
- Store reports: `purchases_store_time_idx`.
- Low stock: a **partial** index over only rows already at or below threshold,
  so the ops dashboard scans a handful of rows rather than the whole table.
- Search: `ilike` over `card_ref`, `display_name`, `participant_ref`. At tens of
  thousands of rows this is fine; a `pg_trgm` GIN index is the upgrade path if
  the platform ever holds millions.

## Reference numbering

Human-readable references (`TXN-2026-000123`) come from Postgres sequences.
`nextval()` takes no lock, so thousands of concurrent checkouts do not
serialise behind a counter. The cost is that a rolled-back transaction leaves a
gap — standard for financial document numbering, and far better than a
bottleneck on the hot path.

## Soft deletion

`users`, `teams`, `stores` and `products` carry `deleted_at`. Anything a
financial record references is never hard-deleted; foreign keys to ledger,
purchase and refund rows use `ON DELETE RESTRICT` so history cannot be orphaned.
