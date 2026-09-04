import {
  bigint,
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { accountStatus, accountType, ledgerTransactionType } from './enums';
import { events, users } from './identity';
import { teams } from './teams';

/**
 * Every place points can sit. Holder accounts (user and team) are wallets;
 * SYSTEM_* accounts are the counterparties that make each transaction balance.
 *
 * `balance` is materialised for fast reads but is never the source of truth:
 * it equals SUM(ledger_entries.amount) for the account, which is asserted by
 * the reconciliation query and by the test suite.
 */
export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    type: accountType('type').notNull(),
    ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'restrict' }),
    ownerTeamId: uuid('owner_team_id').references(() => teams.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id'),
    name: text('name').notNull(),
    balance: bigint('balance', { mode: 'number' }).notNull().default(0),
    lifetimeCredited: bigint('lifetime_credited', { mode: 'number' }).notNull().default(0),
    lifetimeDebited: bigint('lifetime_debited', { mode: 'number' }).notNull().default(0),
    /** System accounts must go negative (the mint). Wallets must not. */
    allowNegative: boolean('allow_negative').notNull().default(false),
    status: accountStatus('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('accounts_user_type_key')
      .on(t.eventId, t.ownerUserId, t.type)
      .where(sql`${t.ownerUserId} is not null`),
    uniqueIndex('accounts_team_type_key')
      .on(t.eventId, t.ownerTeamId, t.type)
      .where(sql`${t.ownerTeamId} is not null`),
    uniqueIndex('accounts_store_type_key')
      .on(t.eventId, t.storeId, t.type)
      .where(sql`${t.storeId} is not null`),
    uniqueIndex('accounts_event_singleton_key')
      .on(t.eventId, t.type)
      .where(sql`${t.type} in ('SYSTEM_ISSUANCE', 'SYSTEM_FORFEITURE')`),
    index('accounts_event_type_idx').on(t.eventId, t.type),
    // The hard floor. Application code returns a friendly error long before
    // this fires, but if a code path ever forgets, the database refuses.
    check('accounts_balance_non_negative', sql`${t.allowNegative} or ${t.balance} >= 0`),
    check('accounts_lifetime_non_negative', sql`${t.lifetimeCredited} >= 0 and ${t.lifetimeDebited} >= 0`),
    check(
      'accounts_owner_exactly_one',
      sql`(case when ${t.ownerUserId} is null then 0 else 1 end
         + case when ${t.ownerTeamId} is null then 0 else 1 end
         + case when ${t.storeId} is null then 0 else 1 end) <= 1`,
    ),
  ],
);

/**
 * Ledger transaction header. Append-only: an UPDATE or DELETE raises.
 * Corrections are new REVERSAL/REFUND transactions pointing back here.
 */
export const ledgerTransactions = pgTable(
  'ledger_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'restrict' }),
    /** Human-friendly and searchable, e.g. TXN-2026-000123. */
    txnRef: text('txn_ref').notNull(),
    type: ledgerTransactionType('type').notNull(),
    /** What caused this: 'purchase' | 'refund' | 'topup' | 'transfer' | ... */
    referenceType: text('reference_type'),
    referenceId: uuid('reference_id'),
    reason: text('reason').notNull(),
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    /** Set on a REVERSAL: the transaction being compensated. */
    reversesTransactionId: uuid('reverses_transaction_id'),
    idempotencyKey: text('idempotency_key'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('ledger_transactions_ref_key').on(t.txnRef),
    index('ledger_transactions_event_time_idx').on(t.eventId, t.createdAt),
    index('ledger_transactions_reference_idx').on(t.referenceType, t.referenceId),
    index('ledger_transactions_type_idx').on(t.eventId, t.type, t.createdAt),
  ],
);

/**
 * The legs of a transaction. Signed amounts; positive credits the account.
 * A database trigger enforces that the legs of one transaction sum to zero,
 * which is what makes "total points in circulation" a provable figure.
 */
export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'restrict' }),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => ledgerTransactions.id, { onDelete: 'restrict' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    amount: bigint('amount', { mode: 'number' }).notNull(),
    balanceBefore: bigint('balance_before', { mode: 'number' }).notNull(),
    balanceAfter: bigint('balance_after', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ledger_entries_account_time_idx').on(t.accountId, t.createdAt),
    index('ledger_entries_transaction_idx').on(t.transactionId),
    check('ledger_entries_amount_nonzero', sql`${t.amount} <> 0`),
    check(
      'ledger_entries_balance_consistent',
      sql`${t.balanceAfter} = ${t.balanceBefore} + ${t.amount}`,
    ),
  ],
);
