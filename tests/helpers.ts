import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import { getDb, getPool, type Database } from '../lib/db/client';
import { syncRolesAndPermissions } from '../lib/db/bootstrap';
import {
  assignStoreStaff,
  createCategory,
  createEvent,
  createParticipant,
  createProduct,
  createStore,
  createTeam,
  setEventStatus,
} from '../lib/services/provisioning';
import { assignCard, createCards } from '../lib/services/cards';
import { topUpUser } from '../lib/services/wallet';
import { invalidateSettingsCache } from '../lib/settings/service';
import type { EventSettingsPatch } from '../lib/settings/schema';
import { updateEventSettings } from '../lib/settings/service';

const SYSTEM_CONTEXT = { actorUserId: null, requestId: 'test' };

let migrated = false;

/**
 * Migrate once per run, then truncate between tests.
 *
 * The real migration files are applied — not a schema push — so every test run
 * also verifies that migrations produce a working database, triggers and
 * sequences included.
 */
export async function prepareDatabase(): Promise<Database> {
  const db = getDb();
  if (!migrated) {
    const pool = getPool();
    await pool.query(`drop schema if exists public cascade`);
    await pool.query(`drop schema if exists drizzle cascade`);
    await pool.query(`create schema public`);
    await migrate(db, { migrationsFolder: './lib/db/migrations' });
    migrated = true;
  }
  await truncateAll(db);
  await syncRolesAndPermissions(db);
  return db;
}

export async function truncateAll(db: Database): Promise<void> {
  invalidateSettingsCache();
  const result = await db.execute<{ tablename: string }>(sql`
    select tablename from pg_tables
     where schemaname = 'public'
       and tablename not in ('roles', 'permissions', 'role_permissions')
  `);
  const tables = result.rows.map((row) => `"${row.tablename}"`).join(', ');
  if (tables.length > 0) {
    await db.execute(sql.raw(`truncate ${tables} restart identity cascade`));
  }
  // Reference sequences live outside the tables, so restart them too and keep
  // refs stable and readable across tests.
  await db.execute(sql`
    select setval(c.oid, 1, false)
      from pg_class c
     where c.relkind = 'S' and c.relname like '%_ref_seq'
  `);
}

export interface TestWorld {
  db: Database;
  eventId: string;
  adminId: string;
  cashierId: string;
  financeId: string;
  participantId: string;
  otherParticipantId: string;
  teamId: string;
  storeId: string;
  otherStoreId: string;
  burgerId: string;
  drinkId: string;
  hoodieId: string;
  unlimitedId: string;
  cardId: string;
  cardToken: string;
}

/**
 * A small but complete event: one store with stock, two participants with
 * wallets, a card, a cashier scoped to that store, and a second store used to
 * prove that store-scoped authority does not leak.
 */
export async function buildWorld(
  db: Database,
  settings: EventSettingsPatch = {},
): Promise<TestWorld> {
  const { eventId } = await createEvent(
    db,
    {
      slug: 'test-event',
      name: 'Test Event',
      settings: {
        // Thresholds off by default so tests exercise the happy path; the
        // approval tests set them explicitly.
        approvalThresholdTopUp: 0,
        approvalThresholdAdjustment: 0,
        approvalThresholdRefund: 0,
        ...settings,
      },
    },
    SYSTEM_CONTEXT,
  );
  await setEventStatus(db, eventId, 'ACTIVE', SYSTEM_CONTEXT);

  const admin = await createParticipant(
    db,
    { eventId, displayName: 'Admin User', email: 'admin@test.local', roleKey: 'ADMIN' },
    SYSTEM_CONTEXT,
  );
  const finance = await createParticipant(
    db,
    {
      eventId,
      displayName: 'Finance User',
      email: 'finance@test.local',
      roleKey: 'ADMIN',
    },
    SYSTEM_CONTEXT,
  );
  const adminContext = { actorUserId: admin.userId, requestId: 'test' };

  const { teamId } = await createTeam(
    db,
    { eventId, name: 'Team Red', slug: 'team-red' },
    adminContext,
  );

  const participant = await createParticipant(
    db,
    { eventId, displayName: 'Ahmed Hassan', email: 'ahmed@test.local', teamId },
    adminContext,
  );
  const other = await createParticipant(
    db,
    { eventId, displayName: 'Sara Mansour', email: 'sara@test.local', teamId },
    adminContext,
  );

  const { storeId } = await createStore(
    db,
    { eventId, name: 'Food Court', slug: 'food-court' },
    adminContext,
  );
  const { storeId: otherStoreId } = await createStore(
    db,
    { eventId, name: 'Merch Stand', slug: 'merch-stand' },
    adminContext,
  );

  const cashier = await createParticipant(
    db,
    { eventId, displayName: 'Cashier User', email: 'cashier@test.local' },
    adminContext,
  );
  await assignStoreStaff(
    db,
    { eventId, storeId, userId: cashier.userId, role: 'CASHIER' },
    adminContext,
  );

  const { categoryId } = await createCategory(db, { eventId, name: 'Food', slug: 'food' });

  const burger = await createProduct(
    db,
    {
      eventId,
      storeId,
      sku: 'BURGER',
      name: 'Burger',
      pricePoints: 200,
      categoryId,
      initialStock: 10,
    },
    adminContext,
  );
  const drink = await createProduct(
    db,
    { eventId, storeId, sku: 'DRINK', name: 'Drink', pricePoints: 100, initialStock: 50 },
    adminContext,
  );
  const hoodie = await createProduct(
    db,
    { eventId, storeId, sku: 'HOODIE', name: 'Hoodie', pricePoints: 500, initialStock: 1 },
    adminContext,
  );
  const unlimited = await createProduct(
    db,
    {
      eventId,
      storeId,
      sku: 'VRRIDE',
      name: 'VR Experience',
      pricePoints: 150,
      initialStock: 0,
      trackInventory: false,
    },
    adminContext,
  );

  const [card] = await createCards(db, { eventId, count: 1 }, adminContext);
  if (!card) throw new Error('Failed to create test card');
  await assignCard(db, { eventId, cardId: card.cardId, userId: participant.userId }, adminContext);

  return {
    db,
    eventId,
    adminId: admin.userId,
    financeId: finance.userId,
    cashierId: cashier.userId,
    participantId: participant.userId,
    otherParticipantId: other.userId,
    teamId,
    storeId,
    otherStoreId,
    burgerId: burger.productId,
    drinkId: drink.productId,
    hoodieId: hoodie.productId,
    unlimitedId: unlimited.productId,
    cardId: card.cardId,
    cardToken: card.token,
  };
}

/** Give a participant a known starting balance. */
export async function fund(
  world: TestWorld,
  userId: string,
  amount: number,
  key = `fund-${userId}-${amount}-${Math.random()}`,
): Promise<void> {
  await topUpUser(
    world.db,
    {
      eventId: world.eventId,
      userId,
      amountPoints: amount,
      reason: 'Test funding',
      createdBy: world.financeId,
    },
    key,
    { actorUserId: world.financeId, requestId: 'test' },
  );
}

export async function setSettings(
  world: TestWorld,
  patch: EventSettingsPatch,
): Promise<void> {
  await updateEventSettings(world.db, world.eventId, patch, world.adminId);
  invalidateSettingsCache(world.eventId);
}

export async function balanceOf(world: TestWorld, userId: string): Promise<number> {
  const result = await world.db.execute<{ balance: string }>(sql`
    select balance::text as balance from accounts
     where event_id = ${world.eventId}
       and owner_user_id = ${userId}
       and type = 'USER_SPENDABLE'
  `);
  return Number(result.rows[0]?.balance ?? 0);
}

export async function stockOf(world: TestWorld, productId: string): Promise<number> {
  const result = await world.db.execute<{ quantity: string }>(sql`
    select quantity_on_hand::text as quantity from inventory where product_id = ${productId}
  `);
  return Number(result.rows[0]?.quantity ?? 0);
}

export async function countRows(db: Database, table: string): Promise<number> {
  const result = await db.execute<{ count: string }>(
    sql.raw(`select count(*)::text as count from "${table}"`),
  );
  return Number(result.rows[0]?.count ?? 0);
}

/**
 * Run operations truly in parallel.
 *
 * `Promise.all` over async functions that each open their own pooled
 * connection is genuine concurrency at the database, which is what these tests
 * need to observe. Results are settled so a rejected operation is an outcome
 * to assert on, not a thrown test.
 */
export async function inParallel<T>(
  operations: (() => Promise<T>)[],
): Promise<PromiseSettledResult<T>[]> {
  return Promise.allSettled(operations.map((operation) => operation()));
}

export function countFulfilled(results: PromiseSettledResult<unknown>[]): number {
  return results.filter((result) => result.status === 'fulfilled').length;
}

export function rejectionCodes(results: PromiseSettledResult<unknown>[]): string[] {
  return results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => {
      const reason = result.reason as { code?: string; message?: string };
      return reason.code ?? reason.message ?? 'unknown';
    });
}
