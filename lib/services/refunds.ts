import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Database, Transaction } from '../db/client';
import {
  approvalRequests,
  inventory,
  inventoryMovements,
  products,
  purchaseItems,
  purchases,
  refundItems,
  refunds,
  stores,
} from '../db/schema';
import { recordAudit, type AuditContext } from '../audit';
import { nextRef } from '../core/refs';
import { withIdempotency } from '../core/idempotency';
import { getEventSettings } from '../settings/service';
import {
  ApprovalRequiredError,
  FeatureDisabledError,
  NotFoundError,
  RefundNotAllowedError,
  ValidationError,
} from '../errors';
import { lockAccounts, postTransaction } from './ledger';
import { notify } from './notifications';

export interface RefundLine {
  purchaseItemId: string;
  quantity: number;
}

export interface RefundInput {
  eventId: string;
  purchaseId: string;
  /** Omit for a full refund of everything still refundable. */
  lines?: RefundLine[];
  reason: string;
  restockInventory?: boolean;
  requestedBy: string;
  /** Set when a two-person approval already cleared this refund. */
  preApproved?: boolean;
}

/**
 * Either the refund happened, or it was parked for a second approver.
 *
 * "Parked" cannot be signalled by throwing from inside the transaction: the
 * throw would roll back the very approval request it was trying to record.
 * So the work returns this, the transaction commits, and the caller raises
 * ApprovalRequiredError afterwards. Replaying the same idempotency key then
 * returns the same parked request rather than creating a second one.
 */
type RefundOutcome =
  | { kind: 'COMPLETED'; refund: RefundResult }
  | { kind: 'APPROVAL_REQUIRED'; approvalRequestId: string; threshold: number };

export interface RefundResult {
  refundId: string;
  refundRef: string;
  txnRef: string;
  purchaseId: string;
  purchaseRef: string;
  type: 'FULL' | 'PARTIAL';
  amountPoints: number;
  balanceBefore: number;
  balanceAfter: number;
  purchaseStatus: 'REFUNDED' | 'PARTIALLY_REFUNDED';
  restocked: boolean;
}

/**
 * Refund all or part of a purchase.
 *
 * The original purchase and its ledger transaction are never modified. A
 * refund is a new, compensating transaction that points back at the original,
 * so the history reads as what actually happened rather than a tidied version
 * of it.
 */
export async function refundPurchase(
  db: Database,
  input: RefundInput,
  idempotencyKey: string,
  context: AuditContext,
): Promise<{ refund: RefundResult; replayed: boolean }> {
  const settings = await getEventSettings(db, input.eventId);
  if (!settings.allowRefunds) {
    throw new FeatureDisabledError('refunds', 'Refunds are disabled for this event.');
  }
  if (input.reason.trim().length < 3) {
    throw new ValidationError('A refund needs a reason.');
  }

  const result = await withIdempotency<RefundOutcome>(
    db,
    {
      scope: 'purchase.refund',
      key: idempotencyKey,
      actorUserId: input.requestedBy,
      requestBody: {
        purchaseId: input.purchaseId,
        lines: [...(input.lines ?? [])].sort((a, b) =>
          a.purchaseItemId < b.purchaseItemId ? -1 : 1,
        ),
        reason: input.reason,
      },
    },
    async (tx) => {
      const outcome = await performRefund(
        tx,
        input,
        // An already-approved refund must not park itself again.
        input.preApproved ? 0 : settings.approvalThresholdRefund,
        {
          restockDefault: settings.restockOnRefundByDefault,
          ...context,
        },
      );
      return outcome.kind === 'COMPLETED'
        ? { value: outcome, resourceType: 'refund', resourceId: outcome.refund.refundId }
        : {
            value: outcome,
            resourceType: 'approval_request',
            resourceId: outcome.approvalRequestId,
          };
    },
  );

  if (result.value.kind === 'APPROVAL_REQUIRED') {
    throw new ApprovalRequiredError(result.value.approvalRequestId, result.value.threshold);
  }
  const completed = result.value.refund;

  if (!result.replayed) {
    const [purchase] = await db
      .select({ userId: purchases.userId })
      .from(purchases)
      .where(eq(purchases.id, input.purchaseId))
      .limit(1);
    if (purchase) {
      await notify(db, {
        eventId: input.eventId,
        userId: purchase.userId,
        type: 'purchase.refunded',
        title: 'Refund issued',
        body: `${completed.amountPoints.toLocaleString()} points refunded. New balance: ${completed.balanceAfter.toLocaleString()}.`,
        severity: 'SUCCESS',
        data: { refundRef: completed.refundRef, purchaseRef: completed.purchaseRef },
      });
    }
  }

  return { refund: completed, replayed: result.replayed };
}

async function performRefund(
  tx: Transaction,
  input: RefundInput,
  approvalThreshold: number,
  context: AuditContext & { restockDefault: boolean },
): Promise<RefundOutcome> {
  // Lock the purchase so two staff cannot refund the same items concurrently.
  const lockedPurchase = await tx.execute<{
    id: string;
    purchase_ref: string;
    status: string;
    total_points: number;
    refunded_points: number;
    account_id: string;
    user_id: string;
    store_id: string;
  }>(sql`
    select id, purchase_ref, status, total_points, refunded_points,
           account_id, user_id, store_id
      from purchases
     where id = ${input.purchaseId} and event_id = ${input.eventId}
       for update
  `);

  const purchase = lockedPurchase.rows[0];
  if (!purchase) throw new NotFoundError('That purchase');

  if (purchase.status !== 'COMPLETED' && purchase.status !== 'PARTIALLY_REFUNDED') {
    throw new RefundNotAllowedError(
      `A ${purchase.status.toLowerCase().replace('_', ' ')} purchase cannot be refunded.`,
      { status: purchase.status },
    );
  }

  const totalPoints = Number(purchase.total_points);
  const alreadyRefunded = Number(purchase.refunded_points);
  const stillRefundable = totalPoints - alreadyRefunded;
  if (stillRefundable <= 0) {
    throw new RefundNotAllowedError('This purchase has already been fully refunded.');
  }

  const items = await tx
    .select({
      id: purchaseItems.id,
      productId: purchaseItems.productId,
      name: purchaseItems.nameSnapshot,
      unitPricePoints: purchaseItems.unitPricePoints,
      quantity: purchaseItems.quantity,
      refundedQuantity: purchaseItems.refundedQuantity,
    })
    .from(purchaseItems)
    .where(eq(purchaseItems.purchaseId, input.purchaseId));

  const itemById = new Map(items.map((item) => [item.id, item]));

  // Full refund = everything not yet refunded.
  const requestedLines: RefundLine[] =
    input.lines && input.lines.length > 0
      ? input.lines
      : items
          .filter((item) => item.quantity > item.refundedQuantity)
          .map((item) => ({
            purchaseItemId: item.id,
            quantity: item.quantity - item.refundedQuantity,
          }));

  let amount = 0;
  for (const line of requestedLines) {
    const item = itemById.get(line.purchaseItemId);
    if (!item) throw new NotFoundError('One of the purchase lines');
    if (!Number.isInteger(line.quantity) || line.quantity < 1) {
      throw new ValidationError('Refund quantities must be whole numbers of at least 1.');
    }
    const remaining = item.quantity - item.refundedQuantity;
    if (line.quantity > remaining) {
      throw new RefundNotAllowedError(
        `Only ${remaining} × ${item.name} can still be refunded.`,
        { purchaseItemId: item.id, remaining },
      );
    }
    amount += item.unitPricePoints * line.quantity;
  }

  if (amount <= 0) throw new ValidationError('There is nothing to refund.');
  if (amount > stillRefundable) {
    throw new RefundNotAllowedError('That is more than the remaining refundable amount.');
  }

  // Two-person control above the configured threshold. The request is parked;
  // no points move until a different person approves it.
  if (approvalThreshold > 0 && amount >= approvalThreshold) {
    const [request] = await tx
      .insert(approvalRequests)
      .values({
        eventId: input.eventId,
        type: 'LARGE_REFUND',
        amountPoints: amount,
        payload: {
          purchaseId: input.purchaseId,
          lines: requestedLines,
          restockInventory: input.restockInventory ?? context.restockDefault,
        },
        reason: input.reason,
        requestedBy: input.requestedBy,
      })
      .returning({ id: approvalRequests.id });
    if (!request) throw new Error('Failed to record approval request');
    // Returned, not thrown: a throw here would roll back this very row.
    return {
      kind: 'APPROVAL_REQUIRED',
      approvalRequestId: request.id,
      threshold: approvalThreshold,
    };
  }

  const [store] = await tx
    .select({ revenueAccountId: stores.revenueAccountId, name: stores.name })
    .from(stores)
    .where(eq(stores.id, purchase.store_id))
    .limit(1);
  if (!store?.revenueAccountId) throw new Error('Store has no revenue account.');

  /* -- Locks: accounts first, then inventory (the global order) ----------- */
  await lockAccounts(tx, [purchase.account_id, store.revenueAccountId], input.eventId);

  const refundRef = await nextRef(tx, 'refund');
  const isFull = amount === stillRefundable;
  const restock = input.restockInventory ?? context.restockDefault;

  const [refund] = await tx
    .insert(refunds)
    .values({
      eventId: input.eventId,
      refundRef,
      purchaseId: input.purchaseId,
      type: isFull && alreadyRefunded === 0 ? 'FULL' : 'PARTIAL',
      amountPoints: amount,
      restockInventory: restock,
      reason: input.reason,
      status: 'COMPLETED',
      requestedBy: input.requestedBy,
      completedAt: new Date(),
    })
    .returning({ id: refunds.id });
  if (!refund) throw new Error('Failed to create refund');

  await tx.insert(refundItems).values(
    requestedLines.map((line) => {
      const item = itemById.get(line.purchaseItemId);
      if (!item) throw new NotFoundError('One of the purchase lines');
      return {
        refundId: refund.id,
        purchaseItemId: line.purchaseItemId,
        quantity: line.quantity,
        amountPoints: item.unitPricePoints * line.quantity,
      };
    }),
  );

  // Money flows back: store revenue is debited, the participant credited.
  // No max-balance cap here — this is the participant's own money returning.
  const posted = await postTransaction(tx, {
    eventId: input.eventId,
    type: 'REFUND',
    reason: `Refund on ${purchase.purchase_ref}: ${input.reason}`,
    referenceType: 'refund',
    referenceId: refund.id,
    createdBy: input.requestedBy,
    legs: [
      { accountId: store.revenueAccountId, amount: -amount },
      { accountId: purchase.account_id, amount },
    ],
    metadata: { refundRef, purchaseRef: purchase.purchase_ref },
  });

  await tx
    .update(refunds)
    .set({ ledgerTransactionId: posted.transactionId })
    .where(eq(refunds.id, refund.id));

  for (const line of requestedLines) {
    await tx
      .update(purchaseItems)
      .set({ refundedQuantity: sql`${purchaseItems.refundedQuantity} + ${line.quantity}` })
      .where(eq(purchaseItems.id, line.purchaseItemId));
  }

  const newRefundedTotal = alreadyRefunded + amount;
  const purchaseStatus = newRefundedTotal >= totalPoints ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
  await tx
    .update(purchases)
    .set({ refundedPoints: newRefundedTotal, status: purchaseStatus })
    .where(eq(purchases.id, input.purchaseId));

  if (restock) {
    await restockItems(tx, input.eventId, requestedLines, itemById, refund.id, refundRef, input.requestedBy);
  }

  await recordAudit(tx, {
    ...context,
    eventId: input.eventId,
    action: 'purchase.refunded',
    targetType: 'purchase',
    targetId: input.purchaseId,
    before: { refundedPoints: alreadyRefunded, status: purchase.status },
    after: { refundedPoints: newRefundedTotal, status: purchaseStatus, refundRef },
    metadata: { reason: input.reason, amount, restocked: restock },
  });

  const movement = posted.balanceFor(purchase.account_id);

  return {
    kind: 'COMPLETED',
    refund: {
      refundId: refund.id,
      refundRef,
      txnRef: posted.txnRef,
      purchaseId: input.purchaseId,
      purchaseRef: purchase.purchase_ref,
      type: isFull && alreadyRefunded === 0 ? 'FULL' : 'PARTIAL',
      amountPoints: amount,
      balanceBefore: movement.before,
      balanceAfter: movement.after,
      purchaseStatus,
      restocked: restock,
    },
  };
}

async function restockItems(
  tx: Transaction,
  eventId: string,
  lines: RefundLine[],
  itemById: Map<string, { productId: string; name: string }>,
  refundId: string,
  refundRef: string,
  actorUserId: string,
): Promise<void> {
  const productIds = lines
    .map((line) => itemById.get(line.purchaseItemId)?.productId)
    .filter((id): id is string => id !== undefined);
  if (productIds.length === 0) return;

  const stockRows = await tx
    .select({
      id: inventory.id,
      productId: inventory.productId,
      quantityOnHand: inventory.quantityOnHand,
      trackInventory: inventory.trackInventory,
    })
    .from(inventory)
    .where(and(inArray(inventory.productId, productIds), eq(inventory.eventId, eventId)))
    .for('update');

  const stockByProduct = new Map(stockRows.map((row) => [row.productId, row]));

  for (const line of lines) {
    const item = itemById.get(line.purchaseItemId);
    if (!item) continue;
    const stock = stockByProduct.get(item.productId);
    if (!stock || !stock.trackInventory) continue;

    const before = stock.quantityOnHand;
    const after = before + line.quantity;

    await tx.update(inventory).set({ quantityOnHand: after }).where(eq(inventory.id, stock.id));
    await tx.insert(inventoryMovements).values({
      eventId,
      inventoryId: stock.id,
      productId: item.productId,
      type: 'REFUND_RESTOCK',
      quantityDelta: line.quantity,
      quantityBefore: before,
      quantityAfter: after,
      referenceType: 'refund',
      referenceId: refundId,
      reason: `Restocked by ${refundRef}`,
      createdBy: actorUserId,
    });
    // Keep the in-memory view current in case one product spans two lines.
    stock.quantityOnHand = after;
  }
}

/** Refundable amount and per-line remaining quantities, for the refund UI. */
export async function getRefundableSummary(
  db: Database,
  eventId: string,
  purchaseId: string,
): Promise<{
  purchaseRef: string;
  totalPoints: number;
  refundedPoints: number;
  refundablePoints: number;
  lines: { purchaseItemId: string; name: string; unitPricePoints: number; remaining: number }[];
}> {
  const [purchase] = await db
    .select({
      purchaseRef: purchases.purchaseRef,
      totalPoints: purchases.totalPoints,
      refundedPoints: purchases.refundedPoints,
    })
    .from(purchases)
    .where(and(eq(purchases.id, purchaseId), eq(purchases.eventId, eventId)))
    .limit(1);
  if (!purchase) throw new NotFoundError('That purchase');

  const items = await db
    .select({
      id: purchaseItems.id,
      name: purchaseItems.nameSnapshot,
      unitPricePoints: purchaseItems.unitPricePoints,
      quantity: purchaseItems.quantity,
      refundedQuantity: purchaseItems.refundedQuantity,
      productName: products.name,
    })
    .from(purchaseItems)
    .leftJoin(products, eq(products.id, purchaseItems.productId))
    .where(eq(purchaseItems.purchaseId, purchaseId));

  return {
    purchaseRef: purchase.purchaseRef,
    totalPoints: purchase.totalPoints,
    refundedPoints: purchase.refundedPoints,
    refundablePoints: purchase.totalPoints - purchase.refundedPoints,
    lines: items.map((item) => ({
      purchaseItemId: item.id,
      name: item.name,
      unitPricePoints: item.unitPricePoints,
      remaining: item.quantity - item.refundedQuantity,
    })),
  };
}
