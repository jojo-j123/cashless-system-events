import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  allocationMode,
  approvalRequestType,
  approvalStatus,
  batchStatus,
  topupSource,
  topupTargetType,
} from './enums';
import { events, users } from './identity';
import { teams } from './teams';
import { ledgerTransactions } from './ledger';
import { terminals } from './purchases';

export const topups = pgTable(
  'topups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'restrict' }),
    topupRef: text('topup_ref').notNull(),
    targetType: topupTargetType('target_type').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'restrict' }),
    teamId: uuid('team_id').references(() => teams.id, { onDelete: 'restrict' }),
    allocationMode: allocationMode('allocation_mode'),
    amountPoints: bigint('amount_points', { mode: 'number' }).notNull(),
    reason: text('reason').notNull(),
    source: topupSource('source').notNull().default('ADMIN_PANEL'),
    status: approvalStatus('status').notNull().default('COMPLETED'),
    batchId: uuid('batch_id'),
    terminalId: uuid('terminal_id').references(() => terminals.id, { onDelete: 'set null' }),
    ledgerTransactionId: uuid('ledger_transaction_id').references(() => ledgerTransactions.id, {
      onDelete: 'restrict',
    }),
    idempotencyKey: text('idempotency_key'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('topups_ref_key').on(t.topupRef),
    index('topups_event_time_idx').on(t.eventId, t.createdAt),
    index('topups_user_idx').on(t.userId, t.createdAt),
    index('topups_batch_idx').on(t.batchId),
    check('topups_amount_positive', sql`${t.amountPoints} > 0`),
    check(
      'topups_target_consistent',
      sql`(${t.targetType} = 'USER' and ${t.userId} is not null and ${t.teamId} is null)
        or (${t.targetType} = 'TEAM' and ${t.teamId} is not null and ${t.userId} is null)`,
    ),
  ],
);

export const topupBatches = pgTable(
  'topup_batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    filename: text('filename'),
    status: batchStatus('status').notNull().default('DRAFT'),
    totalRows: integer('total_rows').notNull().default(0),
    validRows: integer('valid_rows').notNull().default(0),
    invalidRows: integer('invalid_rows').notNull().default(0),
    totalPoints: bigint('total_points', { mode: 'number' }).notNull().default(0),
    reason: text('reason'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    committedAt: timestamp('committed_at', { withTimezone: true }),
  },
  (t) => [index('topup_batches_event_idx').on(t.eventId, t.createdAt)],
);

/** Staged rows from an uploaded CSV, validated before anything is committed. */
export const topupBatchRows = pgTable(
  'topup_batch_rows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => topupBatches.id, { onDelete: 'cascade' }),
    rowNumber: integer('row_number').notNull(),
    raw: jsonb('raw').notNull(),
    resolvedUserId: uuid('resolved_user_id').references(() => users.id, { onDelete: 'set null' }),
    resolvedTeamId: uuid('resolved_team_id').references(() => teams.id, { onDelete: 'set null' }),
    amountPoints: bigint('amount_points', { mode: 'number' }),
    reason: text('reason'),
    isValid: boolean('is_valid').notNull().default(false),
    error: text('error'),
    topupId: uuid('topup_id').references(() => topups.id, { onDelete: 'set null' }),
  },
  (t) => [uniqueIndex('topup_batch_rows_key').on(t.batchId, t.rowNumber)],
);

export const transfers = pgTable(
  'transfers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'restrict' }),
    transferRef: text('transfer_ref').notNull(),
    fromUserId: uuid('from_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    toUserId: uuid('to_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    amountPoints: bigint('amount_points', { mode: 'number' }).notNull(),
    note: text('note'),
    status: approvalStatus('status').notNull().default('COMPLETED'),
    ledgerTransactionId: uuid('ledger_transaction_id').references(() => ledgerTransactions.id, {
      onDelete: 'restrict',
    }),
    idempotencyKey: text('idempotency_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('transfers_ref_key').on(t.transferRef),
    index('transfers_from_idx').on(t.fromUserId, t.createdAt),
    index('transfers_to_idx').on(t.toUserId, t.createdAt),
    check('transfers_amount_positive', sql`${t.amountPoints} > 0`),
    check('transfers_distinct_parties', sql`${t.fromUserId} <> ${t.toUserId}`),
  ],
);

/**
 * Two-person control for high-value operations. Thresholds are per-event
 * settings; below the threshold nothing lands here.
 */
export const approvalRequests = pgTable(
  'approval_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    type: approvalRequestType('type').notNull(),
    amountPoints: bigint('amount_points', { mode: 'number' }),
    payload: jsonb('payload').notNull(),
    status: approvalStatus('status').notNull().default('PENDING_APPROVAL'),
    reason: text('reason').notNull(),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionNote: text('decision_note'),
    resultReferenceType: text('result_reference_type'),
    resultReferenceId: uuid('result_reference_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('approval_requests_event_status_idx').on(t.eventId, t.status, t.createdAt),
    // The whole point of two-person control: the requester cannot be the approver.
    check('approval_requests_two_person', sql`${t.decidedBy} is null or ${t.decidedBy} <> ${t.requestedBy}`),
  ],
);
