import { route } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/responses';
import { refundSchema } from '@/lib/api/schemas';
import { getRefundableSummary, refundPurchase } from '@/lib/services/refunds';
import { ValidationError } from '@/lib/errors';

export const GET = route({ permission: 'purchase.refund' }, async ({ context, params }) => {
  const purchaseId = params.id;
  if (!purchaseId) throw new ValidationError('A purchase id is required.');
  return ok(await getRefundableSummary(context.db, context.eventId, purchaseId));
});

export const POST = route(
  { permission: 'purchase.refund', body: refundSchema, idempotent: true },
  async ({ context, body, params, idempotencyKey }) => {
    const purchaseId = params.id;
    if (!purchaseId) throw new ValidationError('A purchase id is required.');

    const { refund, replayed } = await refundPurchase(
      context.db,
      {
        eventId: context.eventId,
        purchaseId,
        lines: body.lines,
        reason: body.reason,
        restockInventory: body.restockInventory,
        requestedBy: context.actor.userId,
      },
      idempotencyKey,
      context.audit,
    );

    return replayed ? ok(refund) : created(refund);
  },
);
