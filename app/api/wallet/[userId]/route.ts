import { route } from '@/lib/api/handler';
import { ok } from '@/lib/api/responses';
import { getWalletSummary } from '@/lib/services/wallet';
import { ValidationError } from '@/lib/errors';

export const GET = route({}, async ({ context, params }) => {
  const userId = params.userId;
  if (!userId) throw new ValidationError('A user id is required.');

  context.actor.requireSelfOr(userId, 'wallet.read.self', 'wallet.read.any', {
    eventId: context.eventId,
  });

  return ok(await getWalletSummary(context.db, context.eventId, userId));
});
