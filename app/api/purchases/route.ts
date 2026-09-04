import { and, desc, eq, sql } from 'drizzle-orm';
import { route } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/responses';
import { checkoutSchema } from '@/lib/api/schemas';
import { checkout } from '@/lib/services/purchases';
import { purchases, stores, users } from '@/lib/db/schema';
import { RATE_LIMITS } from '@/lib/core/rate-limit';

/**
 * Checkout.
 *
 * `pos.operate` is scoped to the store in the body, so a cashier assigned to
 * the food court cannot ring up a sale at the merch stand. The Idempotency-Key
 * header is mandatory: without it, a retry over a flaky network could charge
 * twice, and at an event flaky networks are the norm.
 */
export const POST = route(
  {
    permission: 'pos.operate',
    body: checkoutSchema,
    idempotent: true,
    rateLimit: RATE_LIMITS.purchase,
    scope: ({ context, body }) => ({ eventId: context.eventId, storeId: body.storeId }),
  },
  async ({ context, body, idempotencyKey }) => {
    const { receipt, replayed } = await checkout(
      context.db,
      {
        eventId: context.eventId,
        storeId: body.storeId,
        userId: body.userId,
        cardId: body.cardId ?? null,
        terminalId: body.terminalId ?? null,
        cashierUserId: context.actor.userId,
        lines: body.lines,
        notes: body.notes ?? null,
      },
      idempotencyKey,
      context.audit,
    );

    return replayed ? ok(receipt) : created(receipt);
  },
);

export const GET = route({ permission: 'purchase.read.any' }, async ({ request, context }) => {
  const params = new URL(request.url).searchParams;
  const storeId = params.get('storeId');
  const userId = params.get('userId');
  const limit = Math.min(Number(params.get('limit') ?? 50), 200);

  const conditions = [eq(purchases.eventId, context.eventId)];
  if (storeId) conditions.push(eq(purchases.storeId, storeId));
  if (userId) conditions.push(eq(purchases.userId, userId));

  // A store manager sees their own stores only, unless they hold the
  // permission globally.
  const allowedStores = context.actor.storesFor('purchase.read.any', context.eventId);
  if (allowedStores !== null) {
    if (allowedStores.length === 0) return ok({ data: [] });
    conditions.push(sql`${purchases.storeId} = any(${allowedStores})`);
  }

  const rows = await context.db
    .select({
      id: purchases.id,
      purchaseRef: purchases.purchaseRef,
      status: purchases.status,
      totalPoints: purchases.totalPoints,
      refundedPoints: purchases.refundedPoints,
      createdAt: purchases.createdAt,
      storeName: stores.name,
      participantName: users.displayName,
    })
    .from(purchases)
    .innerJoin(stores, eq(stores.id, purchases.storeId))
    .innerJoin(users, eq(users.id, purchases.userId))
    .where(and(...conditions))
    .orderBy(desc(purchases.createdAt))
    .limit(limit);

  return ok({ data: rows });
});
