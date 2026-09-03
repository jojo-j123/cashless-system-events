import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  jsonb,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { cardStatus, cardTechnology, credentialKind, tapOutcome } from './enums';
import { events, users } from './identity';

/**
 * An NFC card holds an identifier and nothing else. No balance, no entitlement.
 * `tokenHash` is the preferred credential; `uid` is the physical chip serial,
 * which is trivially clonable and therefore only accepted when the event
 * explicitly allows UID-only resolution.
 */
export const nfcCards = pgTable(
  'nfc_cards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    /** Human-readable label printed on the card, e.g. CARD-000123. */
    cardRef: text('card_ref').notNull(),
    /** Physical chip UID, uppercase hex, no separators. */
    uid: text('uid'),
    /** SHA-256 of the secret token written to the card. Never stored in clear. */
    tokenHash: text('token_hash'),
    /** Last 4 chars of the token, for support staff to eyeball. Not a secret. */
    tokenLast4: text('token_last4'),
    technology: cardTechnology('technology').notNull().default('NTAG213'),
    status: cardStatus('status').notNull().default('UNASSIGNED'),
    assignedUserId: uuid('assigned_user_id').references(() => users.id, { onDelete: 'set null' }),
    assignedAt: timestamp('assigned_at', { withTimezone: true }),
    unassignedAt: timestamp('unassigned_at', { withTimezone: true }),
    /** Set when this card was replaced; points at its successor. */
    replacedByCardId: uuid('replaced_by_card_id'),
    batchLabel: text('batch_label'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('nfc_cards_event_ref_key').on(t.eventId, t.cardRef),
    uniqueIndex('nfc_cards_event_uid_key')
      .on(t.eventId, t.uid)
      .where(sql`${t.uid} is not null`),
    uniqueIndex('nfc_cards_token_hash_key')
      .on(t.tokenHash)
      .where(sql`${t.tokenHash} is not null`),
    // A person may hold at most one live card per event. Enforced in the DB so
    // a race between two staff members assigning cards cannot produce two.
    uniqueIndex('nfc_cards_one_active_per_user')
      .on(t.eventId, t.assignedUserId)
      .where(sql`${t.assignedUserId} is not null and ${t.status} = 'ACTIVE'`),
    index('nfc_cards_status_idx').on(t.eventId, t.status),
    index('nfc_cards_user_idx').on(t.assignedUserId),
  ],
);

/** Append-only history of everything that ever happened to a card. */
export const cardEvents = pgTable(
  'card_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    cardId: uuid('card_id')
      .notNull()
      .references(() => nfcCards.id, { onDelete: 'cascade' }),
    action: text('action').notNull(),
    fromStatus: cardStatus('from_status'),
    toStatus: cardStatus('to_status'),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    reason: text('reason'),
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('card_events_card_idx').on(t.cardId, t.createdAt)],
);

/**
 * Every credential presentation, resolved or rejected. Drives tap rate limiting,
 * clone detection (same card, two terminals, seconds apart) and support triage.
 */
export const cardTaps = pgTable(
  'card_taps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    cardId: uuid('card_id').references(() => nfcCards.id, { onDelete: 'set null' }),
    credentialKind: credentialKind('credential_kind').notNull(),
    /** Hash of the presented credential, so rejected taps are traceable
     *  without persisting an unknown secret in the clear. */
    credentialFingerprint: text('credential_fingerprint').notNull(),
    outcome: tapOutcome('outcome').notNull(),
    terminalId: uuid('terminal_id'),
    storeId: uuid('store_id'),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('card_taps_card_time_idx').on(t.cardId, t.createdAt),
    index('card_taps_fingerprint_idx').on(t.credentialFingerprint, t.createdAt),
    index('card_taps_event_time_idx').on(t.eventId, t.createdAt),
  ],
);
