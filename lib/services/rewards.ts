import { and, desc, eq, sql } from 'drizzle-orm';
import type { Database, Executor, Transaction } from '../db/client';
import {
  events,
  inventory,
  inventoryMovements,
  rewardRedemptions,
  rewards,
} from '../db/schema';
import type { rewardRedemptionStatus, rewardType } from '../db/schema';
import { recordAudit, type AuditContext } from '../audit';
import { withIdempotency } from '../core/idempotency';
import {
  ConflictError,
  EventNotOperationalError,
  NotFoundError,
  OutOfStockError,
  ValidationError,
} from '../errors';
import { getSystemAccount, getUserAccount, lockAccounts, postTransaction } from './ledger';
import { notify } from './notifications';

export type RewardType = (typeof rewardType.enumValues)[number];
export type RedemptionStatus = (typeof rewardRedemptionStatus.enumValues)[number];

/**
 * Rewards: spend points on something that is not a till purchase.
 *
 * Deliberately **not** gated on game mode. Challenges create points and belong
 * to a game; rewards only spend them, and a plain cashless event has just as
 * much use for "200 points gets you a queue skip" as a gamified one does.
 *
 * The points go to SYSTEM_FORFEITURE rather than a store's revenue account.
 * That is a reporting decision as much as a ledger one: a redemption is not a
 * sale, and pushing it through store revenue would inflate the sales figures
 * operators settle against at the end of an event.
 */

export interface Reward {
  id: string;
  name: string;
  description: string | null;
  type: RewardType;
  costPoints: number;
  /** null means unlimited. */
  stock: number | null;
  productId: string | null;
  isActive: boolean;
  redeemed: number;
}

export interface RedemptionResult {
  redemptionId: string;
  rewardId: string;
  rewardName: string;
  userId: string;
  costPoints: number;
  balanceAfter: number;
  txnRef: string;
}

/* -------------------------------------------------------------------------- */
/* Authoring                                                                  */
/* -------------------------------------------------------------------------- */

export async function createReward(
  db: Database,
  input: {
    eventId: string;
    name: string;
    description?: string | null;
    type?: RewardType;
    costPoints: number;
    stock?: number | null;
    productId?: string | null;
  },
  context: AuditContext,
): Promise<{ rewardId: string }> {
  assertName(input.name);
  assertCost(input.costPoints);
  assertStock(input.stock ?? null);

  return db.transaction(async (tx) => {
    const [reward] = await tx
      .insert(rewards)
      .values({
        eventId: input.eventId,
        name: input.name,
        description: input.description ?? null,
        type: input.type ?? 'PRODUCT',
        costPoints: input.costPoints,
        stock: input.stock ?? null,
        productId: input.productId ?? null,
        isActive: true,
      })
      .returning({ id: rewards.id });
    if (!reward) throw new Error('Failed to create reward');

    await recordAudit(tx, {
      ...context,
      eventId: input.eventId,
      action: 'reward.created',
      targetType: 'reward',
      targetId: reward.id,
      after: { name: input.name, costPoints: input.costPoints, stock: input.stock ?? null },
    });

    return { rewardId: reward.id };
  });
}

export async function updateReward(
  db: Database,
  input: {
    eventId: string;
    rewardId: string;
    name?: string;
    description?: string | null;
    costPoints?: number;
    stock?: number | null;
    isActive?: boolean;
  },
  context: AuditContext,
): Promise<void> {
  if (input.name !== undefined) assertName(input.name);
  if (input.costPoints !== undefined) assertCost(input.costPoints);
  if (input.stock !== undefined) assertStock(input.stock);

  await db.transaction(async (tx) => {
    const before = await loadReward(tx, input.eventId, input.rewardId);

    await tx
      .update(rewards)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.costPoints !== undefined ? { costPoints: input.costPoints } : {}),
        ...(input.stock !== undefined ? { stock: input.stock } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      })
      .where(eq(rewards.id, input.rewardId));

    await recordAudit(tx, {
      ...context,
      eventId: input.eventId,
      action: 'reward.updated',
      targetType: 'reward',
      targetId: input.rewardId,
      before: { name: before.name, costPoints: before.costPoints, stock: before.stock },
      after: {
        name: input.name ?? before.name,
        costPoints: input.costPoints ?? before.costPoints,
        stock: input.stock === undefined ? before.stock : input.stock,
      },
    });
  });
}

export async function listRewards(
  db: Executor,
  eventId: string,
  options: { activeOnly?: boolean } = {},
): Promise<Reward[]> {
  const rows = await db
    .select({
      id: rewards.id,
      name: rewards.name,
      description: rewards.description,
      type: rewards.type,
      costPoints: rewards.costPoints,
      stock: rewards.stock,
      productId: rewards.productId,
      isActive: rewards.isActive,
      // Cancelled redemptions gave their stock back, so they are not "redeemed".
      redeemed: sql<string>`count(${rewardRedemptions.id}) filter (
        where ${rewardRedemptions.status} <> 'CANCELLED'
      )::text`,
    })
    .from(rewards)
    .leftJoin(rewardRedemptions, eq(rewardRedemptions.rewardId, rewards.id))
    .where(
      options.activeOnly
        ? and(eq(rewards.eventId, eventId), eq(rewards.isActive, true))
        : eq(rewards.eventId, eventId),
    )
    .groupBy(rewards.id)
    .orderBy(rewards.costPoints);

  return rows.map((row) => ({ ...row, redeemed: Number(row.redeemed ?? 0) }));
}

/* -------------------------------------------------------------------------- */
/* Redeeming                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Claim a reward and take the points.
 *
 * Locks are taken in the order documented for checkout — accounts first, then
 * inventory — with the reward row in between. Every path that touches accounts
 * and inventory takes them in that order, so a redemption and a checkout
 * racing over the same product cannot deadlock.
 *
 * Stock comes off with a conditional UPDATE rather than a read-then-write:
 * under a race the second request matches no row and is refused, so a reward
 * with one left cannot be claimed twice.
 */
export async function redeemReward(
  db: Database,
  input: { eventId: string; rewardId: string; userId: string; redeemedBy: string },
  idempotencyKey: string,
  context: AuditContext,
): Promise<{ result: RedemptionResult; replayed: boolean }> {
  await assertEventIsLive(db, input.eventId);

  const outcome = await withIdempotency<RedemptionResult>(
    db,
    {
      scope: 'reward.redeem',
      key: idempotencyKey,
      actorUserId: input.redeemedBy,
      requestBody: {
        eventId: input.eventId,
        rewardId: input.rewardId,
        userId: input.userId,
      },
    },
    async (tx) => {
      const reward = await loadReward(tx, input.eventId, input.rewardId);
      if (!reward.isActive) {
        throw new ConflictError('That reward is not available.', 'reward_inactive');
      }

      /* -- Locks, in the documented global order ------------------------- */
      const walletId = await getUserAccount(tx, input.eventId, input.userId, 'USER_SPENDABLE');
      const forfeitureId = await getSystemAccount(tx, input.eventId, 'SYSTEM_FORFEITURE');
      await lockAccounts(tx, [walletId, forfeitureId], input.eventId);

      /* -- Claim the stock ------------------------------------------------ */
      const claimed = await tx.execute<{ stock: number | null }>(sql`
        update rewards
           set stock = stock - 1
         where id = ${input.rewardId}
           and (stock is null or stock > 0)
        returning stock
      `);
      if (claimed.rows.length === 0) {
        throw new OutOfStockError(reward.name, 0, 1);
      }

      /* -- Move the points ------------------------------------------------ */
      const posted = await postTransaction(tx, {
        eventId: input.eventId,
        type: 'REWARD_REDEMPTION',
        reason: `Reward: ${reward.name}`,
        referenceType: 'reward',
        referenceId: input.rewardId,
        createdBy: input.redeemedBy,
        legs: [
          { accountId: walletId, amount: -reward.costPoints },
          { accountId: forfeitureId, amount: reward.costPoints },
        ],
        metadata: { rewardName: reward.name },
      });

      const [redemption] = await tx
        .insert(rewardRedemptions)
        .values({
          eventId: input.eventId,
          rewardId: input.rewardId,
          userId: input.userId,
          // Frozen at what it cost today, not read back through the reward.
          costPoints: reward.costPoints,
          status: 'CLAIMED',
          ledgerTransactionId: posted.transactionId,
        })
        .returning({ id: rewardRedemptions.id });
      if (!redemption) throw new Error('Failed to record redemption');

      // A reward standing for a real product moves real stock, or the shelf and
      // the system disagree by exactly the number of rewards handed out.
      if (reward.productId) {
        await consumeProductStock(tx, {
          eventId: input.eventId,
          productId: reward.productId,
          rewardName: reward.name,
          redemptionId: redemption.id,
          actorUserId: input.redeemedBy,
        });
      }

      const movement = posted.balanceFor(walletId);

      await recordAudit(tx, {
        ...context,
        eventId: input.eventId,
        action: 'reward.redeemed',
        targetType: 'user',
        targetId: input.userId,
        after: {
          redemptionId: redemption.id,
          rewardId: input.rewardId,
          rewardName: reward.name,
          costPoints: reward.costPoints,
          balanceAfter: movement.after,
        },
      });

      return {
        value: {
          redemptionId: redemption.id,
          rewardId: input.rewardId,
          rewardName: reward.name,
          userId: input.userId,
          costPoints: reward.costPoints,
          balanceAfter: movement.after,
          txnRef: posted.txnRef,
        },
        resourceType: 'reward_redemption',
        resourceId: redemption.id,
      };
    },
  );

  if (!outcome.replayed) {
    await notify(db, {
      eventId: input.eventId,
      userId: input.userId,
      type: 'reward.redeemed',
      title: outcome.value.rewardName,
      body: `${outcome.value.costPoints.toLocaleString()} points redeemed. Collect it from staff.`,
      severity: 'SUCCESS',
      data: { redemptionId: outcome.value.redemptionId, cost: outcome.value.costPoints },
    });
  }

  return { result: outcome.value, replayed: outcome.replayed };
}

/** Mark a claimed reward as handed over. */
export async function fulfilRedemption(
  db: Database,
  input: { eventId: string; redemptionId: string; fulfilledBy: string },
  context: AuditContext,
): Promise<void> {
  await db.transaction(async (tx) => {
    const redemption = await loadRedemption(tx, input.eventId, input.redemptionId);

    if (redemption.status === 'FULFILLED') return;
    if (redemption.status === 'CANCELLED') {
      throw new ConflictError('That redemption was cancelled.', 'redemption_cancelled');
    }

    await tx
      .update(rewardRedemptions)
      .set({ status: 'FULFILLED', fulfilledBy: input.fulfilledBy, fulfilledAt: new Date() })
      .where(eq(rewardRedemptions.id, input.redemptionId));

    await recordAudit(tx, {
      ...context,
      eventId: input.eventId,
      action: 'reward.fulfilled',
      targetType: 'reward_redemption',
      targetId: input.redemptionId,
      before: { status: redemption.status },
      after: { status: 'FULFILLED', fulfilledBy: input.fulfilledBy },
    });
  });
}

/**
 * Undo a redemption: give the points back and put the stock back on the shelf.
 *
 * The correction is a compensating transaction, never an edit — the original
 * REWARD_REDEMPTION stays in the ledger exactly as it was posted, and a
 * REVERSAL pointing at it carries the points home.
 */
export async function cancelRedemption(
  db: Database,
  input: {
    eventId: string;
    redemptionId: string;
    reason: string;
    cancelledBy: string;
  },
  idempotencyKey: string,
  context: AuditContext,
): Promise<{ replayed: boolean }> {
  if (input.reason.trim().length < 3) {
    throw new ValidationError('A cancellation needs a reason of at least 3 characters.');
  }

  const outcome = await withIdempotency<{ redemptionId: string }>(
    db,
    {
      scope: 'reward.cancel',
      key: idempotencyKey,
      actorUserId: input.cancelledBy,
      requestBody: { eventId: input.eventId, redemptionId: input.redemptionId },
    },
    async (tx) => {
      const redemption = await loadRedemption(tx, input.eventId, input.redemptionId);
      if (redemption.status === 'CANCELLED') {
        throw new ConflictError('That redemption is already cancelled.', 'already_cancelled');
      }

      const walletId = await getUserAccount(
        tx,
        input.eventId,
        redemption.userId,
        'USER_SPENDABLE',
      );
      const forfeitureId = await getSystemAccount(tx, input.eventId, 'SYSTEM_FORFEITURE');
      await lockAccounts(tx, [walletId, forfeitureId], input.eventId);

      // No max-balance cap: this is the participant's own money coming back.
      const posted = await postTransaction(tx, {
        eventId: input.eventId,
        type: 'REVERSAL',
        reason: `Reward cancelled: ${input.reason}`,
        referenceType: 'reward_redemption',
        referenceId: redemption.id,
        reversesTransactionId: redemption.ledgerTransactionId,
        createdBy: input.cancelledBy,
        legs: [
          { accountId: forfeitureId, amount: -redemption.costPoints },
          { accountId: walletId, amount: redemption.costPoints },
        ],
        metadata: { rewardId: redemption.rewardId },
      });

      // Stock goes back only where it was actually taken. A reward with
      // unlimited stock stays null rather than becoming a number.
      await tx
        .update(rewards)
        .set({ stock: sql`case when ${rewards.stock} is null then null else ${rewards.stock} + 1 end` })
        .where(eq(rewards.id, redemption.rewardId));

      if (redemption.productId) {
        await restoreProductStock(tx, {
          eventId: input.eventId,
          productId: redemption.productId,
          redemptionId: redemption.id,
          actorUserId: input.cancelledBy,
          reason: input.reason,
        });
      }

      await tx
        .update(rewardRedemptions)
        .set({
          status: 'CANCELLED',
          cancelledBy: input.cancelledBy,
          cancelledAt: new Date(),
          cancelReason: input.reason,
          reversalTransactionId: posted.transactionId,
        })
        .where(eq(rewardRedemptions.id, redemption.id));

      await recordAudit(tx, {
        ...context,
        eventId: input.eventId,
        action: 'reward.cancelled',
        targetType: 'reward_redemption',
        targetId: redemption.id,
        before: { status: redemption.status },
        after: { status: 'CANCELLED', refunded: redemption.costPoints },
        metadata: { reason: input.reason },
      });

      return {
        value: { redemptionId: redemption.id },
        resourceType: 'reward_redemption',
        resourceId: redemption.id,
      };
    },
  );

  return { replayed: outcome.replayed };
}

export interface RedemptionRow {
  id: string;
  rewardId: string;
  rewardName: string;
  userId: string;
  costPoints: number;
  status: RedemptionStatus;
  createdAt: Date;
}

export async function listRedemptions(
  db: Executor,
  eventId: string,
  options: { status?: RedemptionStatus; userId?: string; limit?: number } = {},
): Promise<RedemptionRow[]> {
  const filters = [eq(rewardRedemptions.eventId, eventId)];
  if (options.status) filters.push(eq(rewardRedemptions.status, options.status));
  if (options.userId) filters.push(eq(rewardRedemptions.userId, options.userId));

  return db
    .select({
      id: rewardRedemptions.id,
      rewardId: rewardRedemptions.rewardId,
      rewardName: rewards.name,
      userId: rewardRedemptions.userId,
      costPoints: rewardRedemptions.costPoints,
      status: rewardRedemptions.status,
      createdAt: rewardRedemptions.createdAt,
    })
    .from(rewardRedemptions)
    .innerJoin(rewards, eq(rewards.id, rewardRedemptions.rewardId))
    .where(and(...filters))
    .orderBy(desc(rewardRedemptions.createdAt))
    .limit(Math.min(options.limit ?? 100, 500));
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

interface LoadedReward {
  id: string;
  name: string;
  costPoints: number;
  stock: number | null;
  productId: string | null;
  isActive: boolean;
}

async function loadReward(
  tx: Executor,
  eventId: string,
  rewardId: string,
): Promise<LoadedReward> {
  const [reward] = await tx
    .select({
      id: rewards.id,
      name: rewards.name,
      costPoints: rewards.costPoints,
      stock: rewards.stock,
      productId: rewards.productId,
      isActive: rewards.isActive,
    })
    .from(rewards)
    .where(and(eq(rewards.id, rewardId), eq(rewards.eventId, eventId)))
    .limit(1);

  // Scoped by event as well as id, so a reward from another event reads as
  // missing rather than as somebody else's reward.
  if (!reward) throw new NotFoundError('That reward');
  return reward;
}

interface LoadedRedemption {
  id: string;
  rewardId: string;
  userId: string;
  costPoints: number;
  status: RedemptionStatus;
  ledgerTransactionId: string | null;
  productId: string | null;
}

async function loadRedemption(
  tx: Transaction,
  eventId: string,
  redemptionId: string,
): Promise<LoadedRedemption> {
  const [row] = await tx
    .select({
      id: rewardRedemptions.id,
      rewardId: rewardRedemptions.rewardId,
      userId: rewardRedemptions.userId,
      costPoints: rewardRedemptions.costPoints,
      status: rewardRedemptions.status,
      ledgerTransactionId: rewardRedemptions.ledgerTransactionId,
      productId: rewards.productId,
    })
    .from(rewardRedemptions)
    .innerJoin(rewards, eq(rewards.id, rewardRedemptions.rewardId))
    .where(
      and(eq(rewardRedemptions.id, redemptionId), eq(rewardRedemptions.eventId, eventId)),
    )
    .limit(1);

  if (!row) throw new NotFoundError('That redemption');
  return row;
}

/** Take one unit off a tracked product, recording the movement. */
async function consumeProductStock(
  tx: Transaction,
  input: {
    eventId: string;
    productId: string;
    rewardName: string;
    redemptionId: string;
    actorUserId: string;
  },
): Promise<void> {
  const locked = await tx.execute<{
    id: string;
    quantity_on_hand: number;
    track_inventory: boolean;
  }>(sql`
    select id, quantity_on_hand, track_inventory
      from inventory
     where product_id = ${input.productId} and event_id = ${input.eventId}
       for update
  `);

  const stock = locked.rows[0];
  if (!stock || !stock.track_inventory) return;

  const before = Number(stock.quantity_on_hand);
  if (before < 1) throw new OutOfStockError(input.rewardName, before, 1);
  const after = before - 1;

  await tx.update(inventory).set({ quantityOnHand: after }).where(eq(inventory.id, stock.id));

  await tx.insert(inventoryMovements).values({
    eventId: input.eventId,
    inventoryId: stock.id,
    productId: input.productId,
    type: 'SALE',
    quantityDelta: -1,
    quantityBefore: before,
    quantityAfter: after,
    referenceType: 'reward_redemption',
    referenceId: input.redemptionId,
    reason: `Redeemed: ${input.rewardName}`,
    createdBy: input.actorUserId,
  });
}

async function restoreProductStock(
  tx: Transaction,
  input: {
    eventId: string;
    productId: string;
    redemptionId: string;
    actorUserId: string;
    reason: string;
  },
): Promise<void> {
  const locked = await tx.execute<{
    id: string;
    quantity_on_hand: number;
    track_inventory: boolean;
  }>(sql`
    select id, quantity_on_hand, track_inventory
      from inventory
     where product_id = ${input.productId} and event_id = ${input.eventId}
       for update
  `);

  const stock = locked.rows[0];
  if (!stock || !stock.track_inventory) return;

  const before = Number(stock.quantity_on_hand);
  const after = before + 1;

  await tx.update(inventory).set({ quantityOnHand: after }).where(eq(inventory.id, stock.id));

  await tx.insert(inventoryMovements).values({
    eventId: input.eventId,
    inventoryId: stock.id,
    productId: input.productId,
    type: 'REFUND_RESTOCK',
    quantityDelta: 1,
    quantityBefore: before,
    quantityAfter: after,
    referenceType: 'reward_redemption',
    referenceId: input.redemptionId,
    reason: `Redemption cancelled: ${input.reason}`,
    createdBy: input.actorUserId,
  });
}

async function assertEventIsLive(db: Executor, eventId: string): Promise<void> {
  const [event] = await db
    .select({ status: events.status })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  if (!event) throw new NotFoundError('That event');
  if (event.status !== 'ACTIVE') {
    throw new EventNotOperationalError(event.status, 'redeeming a reward');
  }
}

function assertName(name: string): void {
  if (name.trim().length < 2) {
    throw new ValidationError('A reward needs a name of at least 2 characters.');
  }
  if (name.length > 200) {
    throw new ValidationError('That name is too long (200 characters maximum).');
  }
}

function assertCost(costPoints: number): void {
  if (!Number.isInteger(costPoints) || costPoints < 0) {
    throw new ValidationError('The cost must be a whole number of zero or more points.');
  }
  if (costPoints > 100_000_000) {
    throw new ValidationError('That cost is unreasonably large.');
  }
}

function assertStock(stock: number | null): void {
  if (stock === null) return;
  if (!Number.isInteger(stock) || stock < 0) {
    throw new ValidationError('Stock must be a whole number of zero or more, or blank for unlimited.');
  }
}
