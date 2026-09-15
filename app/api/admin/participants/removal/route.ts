import { route } from '@/lib/api/handler';
import { ok } from '@/lib/api/responses';
import { removalCommitSchema } from '@/lib/api/schemas';
import { executeParticipantRemoval } from '@/lib/services/removal';

/**
 * Remove participants from the event in bulk.
 *
 * Gated on `participant.remove` and additionally on `wallet.adjust`: a removal
 * that forfeits a balance moves points, and nobody should reach that through a
 * roster permission alone.
 */
export const POST = route(
  { permission: 'participant.remove', body: removalCommitSchema, idempotent: true },
  async ({ context, body, idempotencyKey }) => {
    context.actor.require('wallet.adjust', { eventId: context.eventId });

    const { plan, replayed } = await executeParticipantRemoval(
      context.db,
      {
        eventId: context.eventId,
        userIds: body.ids,
        reason: body.reason,
        actorUserId: context.actor.userId,
      },
      idempotencyKey,
      context.audit,
    );

    return ok({ ...plan, replayed });
  },
);
