import { and, eq, lte, sql } from 'drizzle-orm';
import type { Database, Executor } from '../db/client';
import { inventory, inventoryMovements, products, stores } from '../db/schema';
import type { inventoryMovementType } from '../db/schema';
import { recordAudit, type AuditContext } from '../audit';
import { ConflictError, NotFoundError, ValidationError } from '../errors';
import { notify } from './notifications';

export type MovementType = (typeof inventoryMovementType.enumValues)[number];

export interface StockLevel {
  productId: string;
  productName: string;
  sku: string;
  storeId: string;
  storeName: string;
  quantityOnHand: number;
  lowStockThreshold: number;
  trackInventory: boolean;
  isLow: boolean;
}

/**
 * Change stock by a signed delta, with an auditable movement row.
 *
 * The row is locked FOR UPDATE first so two concurrent adjustments cannot both
 * read the same "before" value. `quantity_on_hand >= 0` is a CHECK constraint,
 * so even a bug here cannot leave negative stock behind.
 */
export async function adjustStock(
  db: Database,
  input: {
    eventId: string;
    productId: string;
    quantityDelta: number;
    type: MovementType;
    reason: string;
    actorUserId: string;
  },
  context: AuditContext,
): Promise<{ quantityBefore: number; quantityAfter: number; isLow: boolean }> {
  if (!Number.isInteger(input.quantityDelta) || input.quantityDelta === 0) {
    throw new ValidationError('The adjustment must be a non-zero whole number.');
  }
  if (input.reason.trim().length < 3) {
    throw new ValidationError('An inventory adjustment needs a reason.');
  }

  const result = await db.transaction(async (tx) => {
    const locked = await tx.execute<{
      id: string;
      quantity_on_hand: number;
      low_stock_threshold: number;
      track_inventory: boolean;
    }>(sql`
      select id, quantity_on_hand, low_stock_threshold, track_inventory
        from inventory
       where product_id = ${input.productId} and event_id = ${input.eventId}
         for update
    `);

    const stock = locked.rows[0];
    if (!stock) throw new NotFoundError('Stock for that product');

    const before = Number(stock.quantity_on_hand);
    const after = before + input.quantityDelta;

    if (after < 0) {
      throw new ConflictError(
        `That would take stock to ${after}. Only ${before} in hand.`,
        'insufficient_stock',
        { available: before, requested: Math.abs(input.quantityDelta) },
      );
    }

    await tx.update(inventory).set({ quantityOnHand: after }).where(eq(inventory.id, stock.id));

    await tx.insert(inventoryMovements).values({
      eventId: input.eventId,
      inventoryId: stock.id,
      productId: input.productId,
      type: input.type,
      quantityDelta: input.quantityDelta,
      quantityBefore: before,
      quantityAfter: after,
      reason: input.reason,
      createdBy: input.actorUserId,
    });

    await recordAudit(tx, {
      ...context,
      eventId: input.eventId,
      action: 'inventory.adjusted',
      targetType: 'product',
      targetId: input.productId,
      before: { quantityOnHand: before },
      after: { quantityOnHand: after },
      metadata: { type: input.type, reason: input.reason, delta: input.quantityDelta },
    });

    return {
      quantityBefore: before,
      quantityAfter: after,
      isLow: Number(stock.track_inventory) !== 0 && after <= Number(stock.low_stock_threshold),
    };
  });

  if (result.isLow) {
    await notifyStoreManagerOfLowStock(db, input.eventId, input.productId, result.quantityAfter);
  }

  return result;
}

async function notifyStoreManagerOfLowStock(
  db: Database,
  eventId: string,
  productId: string,
  remaining: number,
): Promise<void> {
  const [row] = await db
    .select({
      productName: products.name,
      storeName: stores.name,
      managerUserId: stores.managerUserId,
    })
    .from(products)
    .innerJoin(stores, eq(stores.id, products.storeId))
    .where(eq(products.id, productId))
    .limit(1);

  if (!row?.managerUserId) return;

  await notify(db, {
    eventId,
    userId: row.managerUserId,
    type: 'inventory.low_stock',
    title: 'Low stock',
    body: `${row.productName} at ${row.storeName} is down to ${remaining}.`,
    severity: 'WARNING',
    data: { productId, remaining },
  });
}

export async function setStock(
  db: Database,
  input: {
    eventId: string;
    productId: string;
    quantityOnHand: number;
    reason: string;
    actorUserId: string;
  },
  context: AuditContext,
): Promise<{ quantityBefore: number; quantityAfter: number; isLow: boolean }> {
  if (!Number.isInteger(input.quantityOnHand) || input.quantityOnHand < 0) {
    throw new ValidationError('Stock must be zero or a positive whole number.');
  }

  const [current] = await db
    .select({ quantityOnHand: inventory.quantityOnHand })
    .from(inventory)
    .where(and(eq(inventory.productId, input.productId), eq(inventory.eventId, input.eventId)))
    .limit(1);
  if (!current) throw new NotFoundError('Stock for that product');

  const delta = input.quantityOnHand - current.quantityOnHand;
  if (delta === 0) {
    return {
      quantityBefore: current.quantityOnHand,
      quantityAfter: current.quantityOnHand,
      isLow: false,
    };
  }

  return adjustStock(
    db,
    { ...input, quantityDelta: delta, type: 'ADJUSTMENT' },
    context,
  );
}

export async function listStock(
  db: Executor,
  eventId: string,
  options: { storeId?: string; lowOnly?: boolean } = {},
): Promise<StockLevel[]> {
  const conditions = [eq(inventory.eventId, eventId)];
  if (options.storeId) conditions.push(eq(products.storeId, options.storeId));
  if (options.lowOnly) {
    conditions.push(
      and(
        eq(inventory.trackInventory, true),
        lte(inventory.quantityOnHand, inventory.lowStockThreshold),
      )!,
    );
  }

  const rows = await db
    .select({
      productId: products.id,
      productName: products.name,
      sku: products.sku,
      storeId: stores.id,
      storeName: stores.name,
      quantityOnHand: inventory.quantityOnHand,
      lowStockThreshold: inventory.lowStockThreshold,
      trackInventory: inventory.trackInventory,
    })
    .from(inventory)
    .innerJoin(products, eq(products.id, inventory.productId))
    .innerJoin(stores, eq(stores.id, products.storeId))
    .where(and(...conditions))
    .orderBy(stores.name, products.name);

  return rows.map((row) => ({
    ...row,
    isLow: row.trackInventory && row.quantityOnHand <= row.lowStockThreshold,
  }));
}

export async function getMovements(
  db: Executor,
  eventId: string,
  productId: string,
  limit = 100,
): Promise<(typeof inventoryMovements.$inferSelect)[]> {
  return db
    .select()
    .from(inventoryMovements)
    .where(
      and(
        eq(inventoryMovements.eventId, eventId),
        eq(inventoryMovements.productId, productId),
      ),
    )
    .orderBy(sql`${inventoryMovements.createdAt} desc`)
    .limit(Math.min(limit, 500));
}
