import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { inventoryMovementType, storeStaffRole } from './enums';
import { events, users } from './identity';
import { teams } from './teams';
import { accounts } from './ledger';

export const stores = pgTable(
  'stores',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    logoUrl: text('logo_url'),
    location: text('location'),
    isActive: boolean('is_active').notNull().default(true),
    /** Operational open/closed toggle, independent of `isActive`. */
    isOpen: boolean('is_open').notNull().default(true),
    opensAt: time('opens_at'),
    closesAt: time('closes_at'),
    managerUserId: uuid('manager_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** SYSTEM_STORE_REVENUE account that receives this store's takings. */
    revenueAccountId: uuid('revenue_account_id').references(() => accounts.id, {
      onDelete: 'restrict',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('stores_event_slug_key').on(t.eventId, t.slug),
    index('stores_event_idx').on(t.eventId, t.isActive),
  ],
);

export const storeStaff = pgTable(
  'store_staff',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: storeStaffRole('role').notNull().default('CASHIER'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('store_staff_key').on(t.storeId, t.userId),
    index('store_staff_user_idx').on(t.userId),
  ],
);

export const productCategories = pgTable(
  'product_categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('product_categories_event_slug_key').on(t.eventId, t.slug)],
);

export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    categoryId: uuid('category_id').references(() => productCategories.id, {
      onDelete: 'set null',
    }),
    sku: text('sku').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    imageUrl: text('image_url'),
    /** Authoritative price. The client never supplies a price at checkout. */
    pricePoints: bigint('price_points', { mode: 'number' }).notNull(),
    isActive: boolean('is_active').notNull().default(true),
    maxPerPurchase: integer('max_per_purchase'),
    /** Optional gate: only members of this team may buy the item. */
    restrictedToTeamId: uuid('restricted_to_team_id').references(() => teams.id, {
      onDelete: 'set null',
    }),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('products_store_sku_key').on(t.storeId, t.sku),
    index('products_store_active_idx').on(t.storeId, t.isActive),
    check('products_price_non_negative', sql`${t.pricePoints} >= 0`),
    check('products_max_per_purchase_positive', sql`${t.maxPerPurchase} is null or ${t.maxPerPurchase} > 0`),
  ],
);

/** One row per product. Locked FOR UPDATE during checkout. */
export const inventory = pgTable(
  'inventory',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    quantityOnHand: bigint('quantity_on_hand', { mode: 'number' }).notNull().default(0),
    lowStockThreshold: bigint('low_stock_threshold', { mode: 'number' }).notNull().default(5),
    /** Services and experiences do not deplete; skip the stock check for them. */
    trackInventory: boolean('track_inventory').notNull().default(true),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('inventory_product_key').on(t.productId),
    index('inventory_low_stock_idx')
      .on(t.eventId)
      .where(sql`${t.trackInventory} and ${t.quantityOnHand} <= ${t.lowStockThreshold}`),
    // Storage-layer guarantee against overselling, independent of app logic.
    check('inventory_non_negative', sql`${t.quantityOnHand} >= 0`),
  ],
);

export const inventoryMovements = pgTable(
  'inventory_movements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    inventoryId: uuid('inventory_id')
      .notNull()
      .references(() => inventory.id, { onDelete: 'restrict' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    type: inventoryMovementType('type').notNull(),
    quantityDelta: bigint('quantity_delta', { mode: 'number' }).notNull(),
    quantityBefore: bigint('quantity_before', { mode: 'number' }).notNull(),
    quantityAfter: bigint('quantity_after', { mode: 'number' }).notNull(),
    referenceType: text('reference_type'),
    referenceId: uuid('reference_id'),
    reason: text('reason'),
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('inventory_movements_product_time_idx').on(t.productId, t.createdAt),
    index('inventory_movements_reference_idx').on(t.referenceType, t.referenceId),
    check('inventory_movements_delta_nonzero', sql`${t.quantityDelta} <> 0`),
    check(
      'inventory_movements_consistent',
      sql`${t.quantityAfter} = ${t.quantityBefore} + ${t.quantityDelta}`,
    ),
  ],
);
