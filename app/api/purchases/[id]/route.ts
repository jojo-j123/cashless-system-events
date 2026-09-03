import { eq } from 'drizzle-orm';
import { route } from '@/lib/api/handler';
import { ok } from '@/lib/api/responses';
import { getReceipt } from '@/lib/services/purchases';
import { purchases } from '@/lib/db/schema';
import { NotFoundError, ValidationError } from '@/lib/errors';

export const GET = route({}, async ({ context, params }) => {
  const purchaseId = params.id;
  if (!purchaseId) throw new ValidationError('A purchase id is required.');

  const [owner] = await context.db
    .select({ userId: purchases.userId })
    .from(purchases)
    .where(eq(purchases.id, purchaseId))
    .limit(1);
  if (!owner) throw new NotFoundError('That purchase');

  // A participant may read their own receipt; staff need the broader grant.
  context.actor.requireSelfOr(owner.userId, 'purchase.read.self', 'purchase.read.any', {
    eventId: context.eventId,
  });

  return ok(await getReceipt(context.db, context.eventId, purchaseId));
});
