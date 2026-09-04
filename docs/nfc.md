# NFC

## The one rule

**The card carries an identifier. It never carries a balance.**

A card that stored value would mean: cloning it duplicates money, losing it
loses money, and every terminal must be trusted to do arithmetic correctly.
Instead the card is an index into the database:

```
NFC card → credential → CardService.resolveCard() → account → balance
```

The backend is the only source of truth for identity, balance, permissions and
card status. A lost card can be killed instantly because killing it destroys a
*key*, not money.

## Credentials

| Kind | What it is | Trust |
| --- | --- | --- |
| `TOKEN` | A 256-bit random secret written to the card's NDEF record, stored server-side only as a SHA-256 hash | Preferred |
| `UID` | The chip serial number | **Weak.** Readable and clonable by any phone. Rejected unless `allowUidOnlyResolution` is explicitly enabled |
| `QR` | Short-lived HMAC-signed payload | Fallback when NFC is unavailable |
| `MANUAL_REF` | Staff typing the printed card reference | Audited; for support desks |

The UID default is off deliberately. Treating a UID as proof of identity is
equivalent to treating a printed account number as a password.

## Card lifecycle

```
UNASSIGNED ──assign──→ ACTIVE ──suspend──→ SUSPENDED ──reactivate──→ ACTIVE
                         │                      │
                         ├──mark lost──→ LOST   │
                         ├──replace────→ REPLACED (points at successor)
                         └──deactivate─→ DEACTIVATED
```

Every transition writes to `card_events` (append-only) and `audit_logs`.

**Replacement** retires the old card and activates the new one in a single
transaction, carrying the account across untouched. There is never a moment
where both work or neither does.

## Anti-abuse

| Threat | Control |
| --- | --- |
| Cloned card | Token credentials are 256-bit secrets, not readable serials. `card_taps` records terminal and time, so one identity appearing at two terminals seconds apart is visible. |
| Stolen card | Status change takes effect on the next tap — no propagation delay, because the terminal has no cached authority. |
| Replayed request | Idempotency keys: a replayed purchase returns the original receipt. |
| Rapid repeated taps | `tapCooldownMs` and `maxTapsPerCardPerMinute`, enforced server-side. |
| Two simultaneous checkouts | Row locks on the wallet; the second sees the first's committed balance. |
| Card used after purchase started | Card status is re-verified inside the checkout transaction, not trusted from the earlier tap. |

## Reader abstraction

```ts
interface NFCReader {
  readonly id: ReaderId;
  isSupported(): Promise<boolean>;
  start(handlers: ReaderHandlers): Promise<() => void>;
}
```

Three implementations ship:

- **`WebNFCReader`** — Chrome on Android. Reads the NDEF token.
- **`KeyboardWedgeReader`** — the most common hardware at real events: a USB
  reader that types the value and presses Enter. Nothing to install.
- **`SimulatorReader`** — development only, behind `NEXT_PUBLIC_ENABLE_NFC_SIMULATOR`.

All three emit the same `CardCredential` and hit the same endpoint. **The
simulator is not a bypass**: it produces a real credential from a real card and
goes through identical server-side authorisation, card-status and wallet logic.
There is no code path that skips those checks.

Adding a dedicated NFC terminal, an iOS workflow, or a secure-element card
(DESFire with CMAC) means adding one class here. No service, route or table
changes. The `CardCredential` type is the seam.

## QR fallback

The payload is `CQ1.<participantRef>.<expiry>.<hmac>` — a public reference and
a signature, nothing more. No name, no user id, no balance. It is signed with
the app secret mixed with a per-user secret, so a leaked code says nothing
about anyone else and rotating one user's secret invalidates every code they
ever showed. Default lifetime is 120 seconds, and the participant view
refreshes it automatically, so a screenshot in a group chat is worthless
within minutes.
