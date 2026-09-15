import { route } from '@/lib/api/handler';
import { ok } from '@/lib/api/responses';
import { removalCommitSchema } from '@/lib/api/schemas';
import { executeCardRemoval } from '@/lib/services/removal';

/**
 * Delete or deactivate cards in bulk.
 *
 * The plan is recomputed server-side inside the write transaction, so the
 * client cannot talk the service into deleting a card that has been used since
 * the preview was drawn.
 */
export const POST = route(
  { permission: 'card.remove', body: removalCommitSchema, idempotent: true },
  async ({ context, body, idempotencyKey }) => {
    const { plan, replayed } = await executeCardRemoval(
      context.db,
      {
        eventId: context.eventId,
        cardIds: body.ids,
        reason: body.reason,
        actorUserId: context.actor.userId,
      },
      idempotencyKey,
      context.audit,
    );

    return ok({ ...plan, replayed });
  },
);
