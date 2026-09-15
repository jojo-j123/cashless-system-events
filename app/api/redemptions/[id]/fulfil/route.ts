import { route } from '@/lib/api/handler';
import { ok } from '@/lib/api/responses';
import { fulfilRedemption } from '@/lib/services/rewards';
import { ValidationError } from '@/lib/errors';

export const POST = route({ permission: 'reward.fulfil' }, async ({ context, params }) => {
  const redemptionId = params.id;
  if (!redemptionId) throw new ValidationError('A redemption id is required.');

  await fulfilRedemption(
    context.db,
    { eventId: context.eventId, redemptionId, fulfilledBy: context.actor.userId },
    context.audit,
  );

  return ok({ redemptionId, status: 'FULFILLED' });
});
