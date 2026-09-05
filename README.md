# Cashless Event Platform

An NFC points, wallet and point-of-sale system for live events. Participants
carry an NFC card, staff issue points, and participants spend them at event
stores.

Points are internal currency, not money — but every failure mode is the same as
money's, so the system is built like a financial system: a double-entry
append-only ledger, ACID transactions, idempotency on every money endpoint,
server-side authorisation, and an immutable audit trail.

## The one idea that matters

**The card never holds a balance.** It carries an identifier; the database is
the only source of truth.

```
NFC card → credential → CardService.resolveCard() → account → balance
```

Consequences that fall out of this, for free: a lost card is a lost *key* and
can be killed instantly; a cloned card cannot mint value; a card replacement
carries the wallet across untouched; and no terminal ever has to be trusted to
do arithmetic.

## Quick start

```bash
cp .env.example .env          # then set APP_SECRET: openssl rand -base64 48
npm install
./scripts/ensure-db.sh        # starts a local Postgres and creates the databases
npm run db:migrate
npm run db:seed
npm run dev
```

Open http://localhost:3000. Every seeded account uses the password
`Festival2026!`:

| Email | Role | Lands on |
| --- | --- | --- |
| `superadmin@example.com` | Super Admin | Admin dashboard |
| `admin@example.com` | Admin | Admin dashboard |
| `finance@example.com` | Admin (runs the points desk) | Points & top-ups |
| `storemanager@example.com` | Cashier (every store) | POS |
| `cashier.food-court@example.com` | Cashier (PIN 4821) | POS |
| `participant1@example.com` | Participant | Wallet |

There are three staff roles, and deliberately no tier between them: you own the
system (**super admin**), you run the event (**admin**), or you work a till
(**cashier**). Participant is not a job — every attendee holds it on enrolment.

No NFC hardware? The POS ships a development simulator behind
`NEXT_PUBLIC_ENABLE_NFC_SIMULATOR`. It is **not** a bypass: it produces a real
credential and goes through the same server-side authorisation, card-status and
wallet logic as a physical tap.

## Two kinds of event

An event is created in one of two modes:

| Mode | What it is |
| --- | --- |
| **Normal event** | A cashless event: wallets, top-ups and tills. No teams, no scores. |
| **Game** | Everything a normal event has, plus teams, standings, challenges and scoring. |

This is deliberately **not** two products. The wallet, the till, the ledger and
the cards are identical either way; game mode only ever *adds* a surface on top
of the same spine. Two codepaths would mean every feature shipped from here on
has to answer "but does it work in the other mode?" — a question you pay for at
every event, forever.

So a mode is a named preset over settings that already exist
(`lib/settings/modes.ts`), and the mode an event is in is derived from those
settings rather than stored beside them: two copies of one fact can disagree,
and this one decides what participants can see. Modes are per event, not per
deployment — one instance runs a gamified away-day and a plain cashless
festival at the same time.

**Challenges** are how a game issues points: do a thing, earn points and score.
Setting the reward (`challenge.write`) and marking one complete
(`challenge.award`) are separate permissions, and neither is a cashier's — a
challenge is a way to create points, so it sits on the admin side of the same
line as a top-up. Awarding is a money endpoint: idempotent, double-entry, and
guarded by a unique index so a one-shot challenge cannot pay twice however many
staff mark it complete at once.

## The three surfaces

| Surface | Route | Built for |
| --- | --- | --- |
| Participant wallet | `/me` | Mobile. Balance, history, team, QR fallback |
| Cashier POS | `/pos` | Tablet. Tap → items → confirm, in seconds |
| Admin console | `/admin` | Desktop. Dashboard, cards, points, inventory, audit, live ops |

## Commands

```bash
npm run dev          # development server
npm run build        # production build
npm run typecheck    # tsc --noEmit, strict
npm run lint         # eslint, zero warnings tolerated
npm test             # vitest against a real Postgres database
npm run verify       # all of the above
npm run db:migrate   # apply migrations
npm run db:seed      # realistic demo data
```

## Testing

Tests run against **real PostgreSQL**, not mocks. That is not a preference: row
locking, deadlock avoidance, CHECK constraints and deferred triggers do not
exist in a fake, and the bugs they prevent only appear under genuine
concurrency.

The suite covers, among other things:

- Four simultaneous checkouts against a wallet holding enough for one → exactly
  one succeeds.
- Twelve simultaneous sales against five units of stock → exactly five succeed,
  stock lands on zero.
- The same purchase submitted five times at once → one charge.
- A checkout that fails partway → not one row of partial state survives.
- A cashier session rejected by every points-creating endpoint.
- Ledger conservation asserted after every money test.

```bash
npm test
```

## Documentation

| Document | Contents |
| --- | --- |
| [`docs/architecture.md`](docs/architecture.md) | Layering, the ledger, concurrency, the offline decision |
| [`docs/database.md`](docs/database.md) | Schema, constraints, indexing |
| [`docs/nfc.md`](docs/nfc.md) | Card model, credentials, lifecycle, reader abstraction |
| [`docs/security.md`](docs/security.md) | Auth, RBAC, request security, threat notes |
| [`docs/api.md`](docs/api.md) | Endpoints, errors, idempotency |
| [`docs/deployment.md`](docs/deployment.md) | Environment, scaling, event-day checklist |

## A deliberate decision worth knowing about

**Offline purchases are disabled by default.** Signed offline transactions with
local queues cannot prevent double-spend during a real network partition — a
card tapped at two offline terminals will be approved by both.

What is built instead solves the problem events actually have, which is brief
drops rather than total outage: terminal identity, heartbeats, and a durable
client-side retry queue that replays a submission under its original
idempotency key until the server confirms. A retry can never become a second
charge. The `offlinePosEnabled` flag and per-terminal cap exist for operators
who consciously accept bounded loss, but shipping that on by default would
trade a guaranteed correctness property for a rare convenience.
