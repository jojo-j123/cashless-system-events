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
import { approvalStatus, purchaseStatus, refundType } from './enums';
import { events, users } from './identity';
import { nfcCards } from './cards';
import { accounts, ledgerTransactions } from './ledger';
import { products, stores } from './commerce';

export const terminals = pgTable(
  'terminals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    storeId: uuid('store_id').references(() => stores.id, { onDelete: 'set null' }),
    terminalRef: text('terminal_ref').notNull(),
    name: text('name').notNull(),
    /** SHA-256 of the terminal's API key. Used to sign/authenticate requests. */
    apiKeyHash: text('api_key_hash'),
    appVersion: text('app_version'),
    lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }),
    lastTransactionAt: timestamp('last_transaction_at', { withTimezone: true }),
    assignedCashierUserId: uuid('assigned_cashier_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    isDisabled: boolean('is_disabled').notNull().default(false),
    /** Offline spending is off by default; see docs/architecture.md §9. */
    offlineEnabled: boolean('offline_enabled').notNull().default(false),
    offlineSpendCap: bigint('offline_spend_cap', { mode: 'number' }).notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('terminals_event_ref_key').on(t.eventId, t.terminalRef),
    index('terminals_store_idx').on(t.storeId),
    check('terminals_offline_cap_non_negative', sql`${t.offlineSpendCap} >= 0`),
  ],
);

export const purchases = pgTable(
  'purchases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'restrict' }),
    purchaseRef: text('purchase_ref').notNull(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    terminalId: uuid('terminal_id').references(() => terminals.id, { onDelete: 'set null' }),
    cashierUserId: uuid('cashier_user_id').references(() => users.id, { onDelete: 'set null' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    cardId: uuid('card_id').references(() => nfcCards.id, { onDelete: 'set null' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    status: purchaseStatus('status').notNull().default('PENDING'),
    subtotalPoints: bigint('subtotal_points', { mode: 'number' }).notNull(),
    discountPoints: bigint('discount_points', { mode: 'number' }).notNull().default(0),
    totalPoints: bigint('total_points', { mode: 'number' }).notNull(),
    refundedPoints: bigint('refunded_points', { mode: 'number' }).notNull().default(0),
    balanceBefore: bigint('balance_before', { mode: 'number' }),
    balanceAfter: bigint('balance_after', { mode: 'number' }),
    ledgerTransactionId: uuid('ledger_transaction_id').references(() => ledgerTransactions.id, {
      onDelete: 'restrict',
    }),
    idempotencyKey: text('idempotency_key'),
    failureCode: text('failure_code'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('purchases_ref_key').on(t.purchaseRef),
    index('purchases_user_time_idx').on(t.userId, t.createdAt),
    index('purchases_store_time_idx').on(t.storeId, t.createdAt),
    index('purchases_event_status_idx').on(t.eventId, t.status, t.createdAt),
    index('purchases_terminal_idx').on(t.terminalId, t.createdAt),
    check('purchases_totals_non_negative', sql`${t.subtotalPoints} >= 0 and ${t.totalPoints} >= 0 and ${t.discountPoints} >= 0`),
    check('purchases_refunded_within_total', sql`${t.refundedPoints} >= 0 and ${t.refundedPoints} <= ${t.totalPoints}`),
  ],
);

export const purchaseItems = pgTable(
  'purchase_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    purchaseId: uuid('purchase_id')
      .notNull()
      .references(() => purchases.id, { onDelete: 'restrict' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    /** Snapshots: a later price or name change must not rewrite history. */
    nameSnapshot: text('name_snapshot').notNull(),
    skuSnapshot: text('sku_snapshot').notNull(),
    unitPricePoints: bigint('unit_price_points', { mode: 'number' }).notNull(),
    quantity: integer('quantity').notNull(),
    lineTotalPoints: bigint('line_total_points', { mode: 'number' }).notNull(),
    refundedQuantity: integer('refunded_quantity').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('purchase_items_purchase_idx').on(t.purchaseId),
    index('purchase_items_product_idx').on(t.productId),
    check('purchase_items_quantity_positive', sql`${t.quantity} > 0`),
    check('purchase_items_refunded_within_qty', sql`${t.refundedQuantity} >= 0 and ${t.refundedQuantity} <= ${t.quantity}`),
    check('purchase_items_line_total', sql`${t.lineTotalPoints} = ${t.unitPricePoints} * ${t.quantity}`),
  ],
);

export const refunds = pgTable(
  'refunds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'restrict' }),
    refundRef: text('refund_ref').notNull(),
    purchaseId: uuid('purchase_id')
      .notNull()
      .references(() => purchases.id, { onDelete: 'restrict' }),
    type: refundType('type').notNull(),
    amountPoints: bigint('amount_points', { mode: 'number' }).notNull(),
    restockInventory: boolean('restock_inventory').notNull().default(true),
    reason: text('reason').notNull(),
    status: approvalStatus('status').notNull().default('COMPLETED'),
    ledgerTransactionId: uuid('ledger_transaction_id').references(() => ledgerTransactions.id, {
      onDelete: 'restrict',
    }),
    idempotencyKey: text('idempotency_key'),
    requestedBy: uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),
    approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('refunds_ref_key').on(t.refundRef),
    index('refunds_purchase_idx').on(t.purchaseId),
    index('refunds_event_time_idx').on(t.eventId, t.createdAt),
    check('refunds_amount_positive', sql`${t.amountPoints} > 0`),
  ],
);

export const refundItems = pgTable(
  'refund_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    refundId: uuid('refund_id')
      .notNull()
      .references(() => refunds.id, { onDelete: 'restrict' }),
    purchaseItemId: uuid('purchase_item_id')
      .notNull()
      .references(() => purchaseItems.id, { onDelete: 'restrict' }),
    quantity: integer('quantity').notNull(),
    amountPoints: bigint('amount_points', { mode: 'number' }).notNull(),
  },
  (t) => [
    index('refund_items_refund_idx').on(t.refundId),
    check('refund_items_quantity_positive', sql`${t.quantity} > 0`),
  ],
);
