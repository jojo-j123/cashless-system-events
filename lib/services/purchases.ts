import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Database, Executor, Transaction } from '../db/client';
import {
  events,
  inventory,
  inventoryMovements,
  nfcCards,
  products,
  purchaseItems,
  purchases,
  stores,
  teamMembers,
  terminals,
  users,
} from '../db/schema';
import { recordAudit, type AuditContext } from '../audit';
import { nextRef } from '../core/refs';
import { withIdempotency } from '../core/idempotency';
import { getEventSettings } from '../settings/service';
import {
  ConflictError,
  EventNotOperationalError,
  LimitExceededError,
  NotFoundError,
  OutOfStockError,
  ProductUnavailableError,
  StoreClosedError,
  ValidationError,
} from '../errors';
import { getUserAccount, lockAccounts, postTransaction } from './ledger';
import { notify } from './notifications';

export interface CartLine {
  productId: string;
  quantity: number;
}

export interface CheckoutInput {
  eventId: string;
  storeId: string;
  cardId?: string | null;
  userId: string;
  terminalId?: string | null;
  cashierUserId: string;
  lines: CartLine[];
  notes?: string | null;
}

export interface ReceiptLine {
  productId: string;
  name: string;
  sku: string;
  unitPricePoints: number;
  quantity: number;
  lineTotalPoints: number;
}

export interface Receipt {
  purchaseId: string;
  purchaseRef: string;
  txnRef: string;
  status: 'COMPLETED';
  storeId: string;
  storeName: string;
  userId: string;
  participantName: string;
  cashierUserId: string;
  lines: ReceiptLine[];
  subtotalPoints: number;
  discountPoints: number;
  totalPoints: number;
  balanceBefore: number;
  balanceAfter: number;
  lowBalance: boolean;
  createdAt: string;
}

/**
 * Run a checkout.
 *
 * Wrapped in idempotency, so the POS can retry the identical request over a
 * flaky event network without any risk of charging twice. Everything inside is
 * one database transaction: if any step fails, no points moved and no stock
 * changed.
 *
 * Nothing the client sends about price, total, or balance is trusted. Prices
 * come from the products table, the balance from the locked account row.
 */
export async function checkout(
  db: Database,
  input: CheckoutInput,
  idempotencyKey: string,
  context: AuditContext,
): Promise<{ receipt: Receipt; replayed: boolean }> {
  if (input.lines.length === 0) {
    throw new ValidationError('The basket is empty.');
  }
  if (input.lines.length > 100) {
    throw new ValidationError('A single purchase cannot contain more than 100 lines.');
  }

  const merged = mergeLines(input.lines);
  const settings = await getEventSettings(db, input.eventId);

  const result = await withIdempotency<Receipt>(
    db,
    {
      scope: 'purchase.checkout',
      key: idempotencyKey,
      actorUserId: input.cashierUserId,
      requestBody: {
        eventId: input.eventId,
        storeId: input.storeId,
        userId: input.userId,
        lines: merged,
      },
    },
    async (tx) => {
      const receipt = await performCheckout(tx, input, merged, settings.maxSinglePurchase, context);
      return { value: receipt, resourceType: 'purchase', resourceId: receipt.purchaseId };
    },
  );

  // Notifications are deliberately outside the money transaction: a failed
  // push must never roll back a completed purchase.
  if (!result.replayed) {
    await notify(db, {
      eventId: input.eventId,
      userId: input.userId,
      type: 'purchase.completed',
      title: 'Purchase complete',
      body: `${result.value.totalPoints.toLocaleString()} points spent at ${result.value.storeName}. New balance: ${result.value.balanceAfter.toLocaleString()}.`,
      severity: 'SUCCESS',
      data: { purchaseId: result.value.purchaseId, purchaseRef: result.value.purchaseRef },
    });

    if (result.value.lowBalance) {
      await notify(db, {
        eventId: input.eventId,
        userId: input.userId,
        type: 'wallet.low_balance',
        title: 'Low balance',
        body: `Your balance is down to ${result.value.balanceAfter.toLocaleString()} points.`,
        severity: 'WARNING',
        data: { balance: result.value.balanceAfter },
      });
    }
  }

  return { receipt: result.value, replayed: result.replayed };
}

async function performCheckout(
  tx: Transaction,
  input: CheckoutInput,
  lines: CartLine[],
  maxSinglePurchase: number,
  context: AuditContext,
): Promise<Receipt> {
  /* -- 1. Event and store must both be open for business ------------------ */
  const [event] = await tx
    .select({ status: events.status })
    .from(events)
    .where(eq(events.id, input.eventId))
    .limit(1);
  if (!event) throw new NotFoundError('That event');
  if (event.status !== 'ACTIVE') {
    throw new EventNotOperationalError(event.status, 'checkout');
  }

  const [store] = await tx
    .select({
      id: stores.id,
      name: stores.name,
      isActive: stores.isActive,
      isOpen: stores.isOpen,
      revenueAccountId: stores.revenueAccountId,
      deletedAt: stores.deletedAt,
    })
    .from(stores)
    .where(and(eq(stores.id, input.storeId), eq(stores.eventId, input.eventId)))
    .limit(1);
  if (!store || store.deletedAt !== null) throw new NotFoundError('That store');
  if (!store.isActive || !store.isOpen) throw new StoreClosedError(store.name);
  if (!store.revenueAccountId) {
    throw new Error(`Store ${store.id} has no revenue account.`);
  }

  /* -- 2. Re-verify the card server-side ---------------------------------- */
  // The POS resolved this card moments ago, but a card can be reported lost
  // between the tap and the confirm. Never trust the earlier resolution.
  if (input.cardId) {
    const [card] = await tx
      .select({ status: nfcCards.status, assignedUserId: nfcCards.assignedUserId })
      .from(nfcCards)
      .where(and(eq(nfcCards.id, input.cardId), eq(nfcCards.eventId, input.eventId)))
      .limit(1);
    if (card) {
      if (card.status !== 'ACTIVE' || card.assignedUserId !== input.userId) {
        throw new ConflictError(
          'This card is no longer valid for that account. Please tap again.',
          'card_not_usable',
        );
      }
    }
  }

  /* -- 3. Load products and price them from the database ------------------ */
  const productIds = lines.map((line) => line.productId);
  const catalogue = await tx
    .select({
      id: products.id,
      name: products.name,
      sku: products.sku,
      pricePoints: products.pricePoints,
      isActive: products.isActive,
      deletedAt: products.deletedAt,
      storeId: products.storeId,
      maxPerPurchase: products.maxPerPurchase,
      restrictedToTeamId: products.restrictedToTeamId,
      inventoryId: inventory.id,
      quantityOnHand: inventory.quantityOnHand,
      trackInventory: inventory.trackInventory,
    })
    .from(products)
    .leftJoin(inventory, eq(inventory.productId, products.id))
    .where(and(inArray(products.id, productIds), eq(products.eventId, input.eventId)));

  const byId = new Map(catalogue.map((row) => [row.id, row]));
  for (const line of lines) {
    const product = byId.get(line.productId);
    if (!product || product.deletedAt !== null) {
      throw new NotFoundError('One of the items');
    }
    if (product.storeId !== input.storeId) {
      throw new ProductUnavailableError(`${product.name} is not sold at ${store.name}.`);
    }
    if (!product.isActive) {
      throw new ProductUnavailableError(`${product.name} is not available.`);
    }
    if (product.maxPerPurchase !== null && line.quantity > product.maxPerPurchase) {
      throw new LimitExceededError(
        'maxPerPurchase',
        product.maxPerPurchase,
        line.quantity,
        `Limit ${product.maxPerPurchase} × ${product.name} per purchase.`,
      );
    }
  }

  const restricted = [...byId.values()].filter((row) => row.restrictedToTeamId !== null);
  if (restricted.length > 0) {
    const [membership] = await tx
      .select({ teamId: teamMembers.teamId })
      .from(teamMembers)
      .where(
        and(eq(teamMembers.userId, input.userId), eq(teamMembers.eventId, input.eventId)),
      )
      .limit(1);
    for (const product of restricted) {
      if (membership?.teamId !== product.restrictedToTeamId) {
        throw new ProductUnavailableError(`${product.name} is reserved for another team.`);
      }
    }
  }

  const receiptLines: ReceiptLine[] = lines.map((line) => {
    const product = byId.get(line.productId);
    if (!product) throw new NotFoundError('One of the items');
    return {
      productId: product.id,
      name: product.name,
      sku: product.sku,
      unitPricePoints: product.pricePoints,
      quantity: line.quantity,
      lineTotalPoints: product.pricePoints * line.quantity,
    };
  });

  const subtotal = receiptLines.reduce((sum, line) => sum + line.lineTotalPoints, 0);
  const total = subtotal;

  if (total > maxSinglePurchase) {
    throw new LimitExceededError(
      'maxSinglePurchase',
      maxSinglePurchase,
      total,
      `That total (${total.toLocaleString()}) is above the ${maxSinglePurchase.toLocaleString()} single-purchase limit.`,
    );
  }

  /* -- 4. Acquire locks in the documented global order -------------------- */
  // Accounts first, then inventory; each ascending by id. Every code path that
  // touches both takes them in this order, so deadlock cannot occur.
  const buyerAccountId = await getUserAccount(tx, input.eventId, input.userId);
  const locked = await lockAccounts(
    tx,
    [buyerAccountId, store.revenueAccountId],
    input.eventId,
  );
  const buyerAccount = locked.get(buyerAccountId);
  if (!buyerAccount) throw new NotFoundError("This participant's wallet");

  const inventoryIds = receiptLines
    .map((line) => byId.get(line.productId))
    .filter((row): row is NonNullable<typeof row> => row !== undefined && row.inventoryId !== null)
    .map((row) => row.inventoryId as string);

  const stockLevels = await lockInventory(tx, inventoryIds);

  /* -- 5. Stock check against freshly locked rows ------------------------- */
  for (const line of receiptLines) {
    const product = byId.get(line.productId);
    if (!product?.inventoryId) continue;
    const stock = stockLevels.get(product.inventoryId);
    if (!stock || !stock.trackInventory) continue;
    if (stock.quantityOnHand < line.quantity) {
      throw new OutOfStockError(product.name, stock.quantityOnHand, line.quantity);
    }
  }

  /* -- 6. Write the purchase --------------------------------------------- */
  const purchaseRef = await nextRef(tx, 'purchase');
  const [purchase] = await tx
    .insert(purchases)
    .values({
      eventId: input.eventId,
      purchaseRef,
      storeId: input.storeId,
      terminalId: input.terminalId ?? null,
      cashierUserId: input.cashierUserId,
      userId: input.userId,
      cardId: input.cardId ?? null,
      accountId: buyerAccountId,
      status: 'PENDING',
      subtotalPoints: subtotal,
      totalPoints: total,
      notes: input.notes ?? null,
    })
    .returning({ id: purchases.id, createdAt: purchases.createdAt });
  if (!purchase) throw new Error('Failed to create purchase');

  await tx.insert(purchaseItems).values(
    receiptLines.map((line) => ({
      purchaseId: purchase.id,
      productId: line.productId,
      nameSnapshot: line.name,
      skuSnapshot: line.sku,
      unitPricePoints: line.unitPricePoints,
      quantity: line.quantity,
      lineTotalPoints: line.lineTotalPoints,
    })),
  );

  /* -- 7. Move the points ------------------------------------------------- */
  // A zero-total basket (all free items) has nothing to post; the ledger
  // refuses empty transactions, and rightly so.
  let txnRef = '';
  let ledgerTransactionId: string | null = null;
  let balanceBefore = buyerAccount.balance;
  let balanceAfter = buyerAccount.balance;

  if (total > 0) {
    const posted = await postTransaction(tx, {
      eventId: input.eventId,
      type: 'PURCHASE',
      reason: `Purchase at ${store.name}`,
      referenceType: 'purchase',
      referenceId: purchase.id,
      createdBy: input.cashierUserId,
      legs: [
        { accountId: buyerAccountId, amount: -total },
        { accountId: store.revenueAccountId, amount: total },
      ],
      metadata: { purchaseRef, storeId: input.storeId, lineCount: receiptLines.length },
    });
    txnRef = posted.txnRef;
    ledgerTransactionId = posted.transactionId;
    const movement = posted.balanceFor(buyerAccountId);
    balanceBefore = movement.before;
    balanceAfter = movement.after;
  }

  /* -- 8. Reduce stock ---------------------------------------------------- */
  for (const line of receiptLines) {
    const product = byId.get(line.productId);
    if (!product?.inventoryId) continue;
    const stock = stockLevels.get(product.inventoryId);
    if (!stock || !stock.trackInventory) continue;

    const before = stock.quantityOnHand;
    const after = before - line.quantity;

    await tx
      .update(inventory)
      .set({ quantityOnHand: after })
      .where(eq(inventory.id, product.inventoryId));

    await tx.insert(inventoryMovements).values({
      eventId: input.eventId,
      inventoryId: product.inventoryId,
      productId: line.productId,
      type: 'SALE',
      quantityDelta: -line.quantity,
      quantityBefore: before,
      quantityAfter: after,
      referenceType: 'purchase',
      referenceId: purchase.id,
      reason: `Sold on ${purchaseRef}`,
      createdBy: input.cashierUserId,
    });
  }

  /* -- 9. Finalise -------------------------------------------------------- */
  await tx
    .update(purchases)
    .set({
      status: 'COMPLETED',
      ledgerTransactionId,
      balanceBefore,
      balanceAfter,
      completedAt: new Date(),
    })
    .where(eq(purchases.id, purchase.id));

  if (input.terminalId) {
    await tx
      .update(terminals)
      .set({ lastTransactionAt: new Date() })
      .where(eq(terminals.id, input.terminalId));
  }

  await recordAudit(tx, {
    ...context,
    eventId: input.eventId,
    action: 'purchase.completed',
    targetType: 'purchase',
    targetId: purchase.id,
    after: { purchaseRef, total, balanceBefore, balanceAfter, storeId: input.storeId },
  });

  const settings = await getEventSettings(tx, input.eventId);

  // The cashier is handing goods to a person, and the receipt is where they
  // confirm they charged the right one. Leaving this blank made the till say
  // a balance without saying whose.
  const [buyer] = await tx
    .select({ displayName: users.displayName })
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1);

  return {
    purchaseId: purchase.id,
    purchaseRef,
    txnRef,
    status: 'COMPLETED',
    storeId: store.id,
    storeName: store.name,
    userId: input.userId,
    participantName:
      context.actorUserId === input.userId ? 'You' : (buyer?.displayName ?? ''),
    cashierUserId: input.cashierUserId,
    lines: receiptLines,
    subtotalPoints: subtotal,
    discountPoints: 0,
    totalPoints: total,
    balanceBefore,
    balanceAfter,
    lowBalance: balanceAfter < settings.lowBalanceThreshold,
    createdAt: purchase.createdAt.toISOString(),
  };
}

type LockedStock = { id: string; quantityOnHand: number; trackInventory: boolean };

/**
 * Lock inventory rows FOR UPDATE, ascending by id.
 *
 * Two cashiers selling the last hoodie at the same instant serialise here: the
 * second sees the first's committed quantity and is rejected cleanly.
 */
async function lockInventory(
  tx: Transaction,
  inventoryIds: string[],
): Promise<Map<string, LockedStock>> {
  const unique = [...new Set(inventoryIds)];
  if (unique.length === 0) return new Map();

  const rows = await tx.execute<{
    id: string;
    quantity_on_hand: number;
    track_inventory: boolean;
  }>(sql`
    select id, quantity_on_hand, track_inventory
      from inventory
     where id = any(${sql.raw(`ARRAY[${unique.map((id) => `'${assertUuid(id)}'`).join(',')}]::uuid[]`)})
     order by id
       for update
  `);

  return new Map(
    rows.rows.map((row) => [
      row.id,
      {
        id: row.id,
        quantityOnHand: Number(row.quantity_on_hand),
        trackInventory: row.track_inventory,
      },
    ]),
  );
}

function assertUuid(value: string): string {
  if (!/^[0-9a-fA-F-]{36}$/.test(value)) throw new Error('Invalid inventory id.');
  return value;
}

/** Combine duplicate lines so one product is locked and checked exactly once. */
function mergeLines(lines: CartLine[]): CartLine[] {
  const totals = new Map<string, number>();
  for (const line of lines) {
    if (!Number.isInteger(line.quantity) || line.quantity < 1) {
      throw new ValidationError('Quantities must be whole numbers of at least 1.');
    }
    if (line.quantity > 1_000) {
      throw new ValidationError('A single line cannot exceed 1,000 units.');
    }
    totals.set(line.productId, (totals.get(line.productId) ?? 0) + line.quantity);
  }
  return [...totals.entries()]
    .map(([productId, quantity]) => ({ productId, quantity }))
    // Sorted so the idempotency request hash is stable regardless of the
    // order the cashier happened to scan items in.
    .sort((a, b) => (a.productId < b.productId ? -1 : 1));
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

export async function getReceipt(
  db: Executor,
  eventId: string,
  purchaseId: string,
): Promise<Receipt> {
  const [purchase] = await db
    .select({
      id: purchases.id,
      purchaseRef: purchases.purchaseRef,
      status: purchases.status,
      storeId: purchases.storeId,
      storeName: stores.name,
      userId: purchases.userId,
      participantName: users.displayName,
      cashierUserId: purchases.cashierUserId,
      subtotalPoints: purchases.subtotalPoints,
      discountPoints: purchases.discountPoints,
      totalPoints: purchases.totalPoints,
      refundedPoints: purchases.refundedPoints,
      balanceBefore: purchases.balanceBefore,
      balanceAfter: purchases.balanceAfter,
      createdAt: purchases.createdAt,
    })
    .from(purchases)
    .innerJoin(stores, eq(stores.id, purchases.storeId))
    .innerJoin(users, eq(users.id, purchases.userId))
    .where(and(eq(purchases.id, purchaseId), eq(purchases.eventId, eventId)))
    .limit(1);

  if (!purchase) throw new NotFoundError('That purchase');

  const items = await db
    .select()
    .from(purchaseItems)
    .where(eq(purchaseItems.purchaseId, purchaseId));

  return {
    purchaseId: purchase.id,
    purchaseRef: purchase.purchaseRef,
    txnRef: '',
    status: 'COMPLETED',
    storeId: purchase.storeId,
    storeName: purchase.storeName,
    userId: purchase.userId,
    participantName: purchase.participantName,
    cashierUserId: purchase.cashierUserId ?? '',
    lines: items.map((item) => ({
      productId: item.productId,
      name: item.nameSnapshot,
      sku: item.skuSnapshot,
      unitPricePoints: item.unitPricePoints,
      quantity: item.quantity,
      lineTotalPoints: item.lineTotalPoints,
    })),
    subtotalPoints: purchase.subtotalPoints,
    discountPoints: purchase.discountPoints,
    totalPoints: purchase.totalPoints,
    balanceBefore: purchase.balanceBefore ?? 0,
    balanceAfter: purchase.balanceAfter ?? 0,
    lowBalance: false,
    createdAt: purchase.createdAt.toISOString(),
  };
}
