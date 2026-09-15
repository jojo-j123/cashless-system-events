import { route } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/responses';
import { rewardRedeemSchema } from '@/lib/api/schemas';
import { redeemReward } from '@/lib/services/rewards';
import { ValidationError } from '@/lib/errors';

/**
 * Claim a reward. Spends points, so an Idempotency-Key is mandatory and a
 * retried submission returns the original claim rather than charging twice.
 */
export const POST = route(
  { permission: 'reward.redeem.self', body: rewardRedeemSchema, idempotent: true },
  async ({ context, body, params, idempotencyKey }) => {
    const rewardId = params.id;
    if (!rewardId) throw new ValidationError('A reward id is required.');

    // Redeeming for yourself is a participant's own business; doing it for
    // somebody else spends their points and is a staff action.
    const targetUserId = body.userId ?? context.actor.userId;
    context.actor.requireSelfOr(
      targetUserId,
      'reward.redeem.self',
      'reward.redeem.any',
      { eventId: context.eventId },
    );

    const { result, replayed } = await redeemReward(
      context.db,
      {
        eventId: context.eventId,
        rewardId,
        userId: targetUserId,
        redeemedBy: context.actor.userId,
      },
      idempotencyKey,
      context.audit,
    );

    return replayed ? ok(result) : created(result);
  },
);
