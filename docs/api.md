# API

All routes are under `/api`. JSON in, JSON out. Authentication is a session
cookie; mutations additionally require the `x-csrf-token` header.

## Conventions

**Errors** always take this shape:

```json
{
  "error": { "code": "insufficient_points", "message": "Insufficient points. Balance is 150, this costs 200.", "details": { "balance": 150, "required": 200, "shortfall": 50 } },
  "requestId": "0f3c…"
}
```

`message` is written to be shown to a cashier or participant as-is. `code` is
stable and safe to branch on.

| Status | Meaning |
| --- | --- |
| 200 / 201 | Success (201 for a newly created resource; a replayed idempotent request returns 200) |
| 202 | Accepted but parked for a second approver (`approval_required`) |
| 400 | Missing `Idempotency-Key` |
| 401 | Not signed in |
| 403 | Signed in, not permitted — or CSRF/Origin failed |
| 404 | Not found |
| 409 | Business conflict: insufficient points, out of stock, card suspended, key reused |
| 422 | Validation failed, or a limit exceeded |
| 429 | Rate limited (`Retry-After` header set) |
| 500 | Bug. Correlation id in `requestId`; details are logged server-side only |

**Idempotency.** Every money endpoint requires `Idempotency-Key`. Replaying the
same key with the same body returns the original response and creates nothing.
Replaying with a *different* body is `409 idempotency_key_reused` — that is
always a client bug, and failing loudly beats silently picking one.

**Multi-event.** Pass `x-event-id` to target a specific event. Omitted, the
single active event is used; if more than one is active the request fails rather
than guessing.

## Endpoints

### Auth
| Method | Path | Permission |
| --- | --- | --- |
| POST | `/auth/login` | public |
| POST | `/auth/logout` | authenticated |
| GET | `/auth/me` | authenticated |

### Cards
| Method | Path | Permission |
| --- | --- | --- |
| POST | `/cards/resolve` | `card.resolve` (store-scoped) |
| GET | `/cards` | `card.read` |
| POST | `/cards/batch` | `card.write` |
| POST | `/cards/assign` | `card.assign` |
| POST | `/cards/{id}/status` | `card.suspend` |
| DELETE | `/cards/{id}/status` | `card.assign` (unassign) |
| GET | `/cards/{id}/history` | `card.read` |
| POST | `/cards/replace` | `card.replace` |

`POST /cards/batch` returns the card tokens **once**. They are stored only as
hashes and cannot be retrieved again.

### Wallet
| Method | Path | Permission | Idempotent |
| --- | --- | --- | --- |
| GET | `/wallet/{userId}` | self or `wallet.read.any` | — |
| GET | `/wallet/{userId}/transactions` | self or `wallet.read.any` | — |
| POST | `/wallet/top-up` | `wallet.topup` | required |
| POST | `/wallet/top-up/team` | `team.allocate` | required |
| POST | `/wallet/adjust` | `wallet.adjust` | required |
| POST | `/wallet/transfer` | `wallet.transfer.self` | required |

Team allocation takes an explicit `mode`, because "give the team 10,000 points"
is genuinely ambiguous: `TEAM_WALLET`, `TEAM_SCORE`,
`SPLIT_EQUALLY_TO_MEMBERS`, or `EACH_MEMBER_FULL_AMOUNT`.

### Purchases
| Method | Path | Permission | Idempotent |
| --- | --- | --- | --- |
| POST | `/purchases` | `pos.operate` (store-scoped) | required |
| GET | `/purchases` | `purchase.read.any` | — |
| GET | `/purchases/{id}` | self or `purchase.read.any` | — |
| GET | `/purchases/{id}/refund` | `purchase.refund` | — |
| POST | `/purchases/{id}/refund` | `purchase.refund` | required |

The checkout body carries product ids and quantities only. **No prices, no
totals** — the server prices the basket from the products table and that figure
is what is charged.

### Commerce, reporting and operations
`/stores`, `/stores/{id}/products`, `/products`, `/products/{id}`,
`/inventory`, `/inventory/adjust`, `/reports/overview`, `/reports/sales`,
`/reports/products`, `/reports/ops`, `/leaderboards`, `/participants`,
`/teams`, `/terminals`, `/terminals/{id}/heartbeat`, `/approvals`,
`/approvals/{id}`, `/notifications`, `/audit`, `/settings`, `/search`,
`/export`, `/qr`, `/health`.

## Example: a checkout

```http
POST /api/purchases
x-csrf-token: <token from the cashless_csrf cookie>
Idempotency-Key: 7f3a9c2e-...

{
  "storeId": "…",
  "userId": "…",
  "cardId": "…",
  "lines": [
    { "productId": "…", "quantity": 1 },
    { "productId": "…", "quantity": 2 }
  ]
}
```

```json
{
  "purchaseRef": "PUR-2026-000041",
  "txnRef": "TXN-2026-000090",
  "status": "COMPLETED",
  "storeName": "Food Court",
  "lines": [ { "name": "Burger", "quantity": 1, "unitPricePoints": 200, "lineTotalPoints": 200 } ],
  "totalPoints": 400,
  "balanceBefore": 1800,
  "balanceAfter": 1400,
  "lowBalance": false,
  "createdAt": "2026-09-03T17:48:22.104Z"
}
```

Submitting that request again with the same key returns the same
`purchaseRef` and charges nothing further.
