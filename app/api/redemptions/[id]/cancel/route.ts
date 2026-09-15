import { route } from '@/lib/api/handler';
import { ok } from '@/lib/api/responses';
import { redemptionCancelSchema } from '@/lib/api/schemas';
import { cancelRedemption } from '@/lib/services/rewards';
import { ValidationError } from '@/lib/errors';

/**
 * Undo a claim: points back, stock back. Money moves, so it is idempotent.
 */
export const POST = route(
  { permission: 'reward.fulfil', body: redemptionCancelSchema, idempotent: true },
  async ({ context, body, params, idempotencyKey }) => {
    const redemptionId = params.id;
    if (!redemptionId) throw new ValidationError('A redemption id is required.');

    await cancelRedemption(
      context.db,
      {
        eventId: context.eventId,
        redemptionId,
        reason: body.reason,
        cancelledBy: context.actor.userId,
      },
      idempotencyKey,
      context.audit,
    );

    return ok({ redemptionId, status: 'CANCELLED' });
  },
);
