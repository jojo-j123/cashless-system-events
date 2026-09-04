import { route } from '@/lib/api/handler';
import { ok } from '@/lib/api/responses';
import { getWalletSummary, getWalletTransactions } from '@/lib/services/wallet';
import { ValidationError } from '@/lib/errors';

export const GET = route({}, async ({ request, context, params }) => {
  const userId = params.userId;
  if (!userId) throw new ValidationError('A user id is required.');

  context.actor.requireSelfOr(userId, 'wallet.read.self', 'wallet.read.any', {
    eventId: context.eventId,
  });

  const search = new URL(request.url).searchParams;
  const wallet = await getWalletSummary(context.db, context.eventId, userId);
  const page = await getWalletTransactions(context.db, wallet.accountId, {
    limit: Number(search.get('limit') ?? 25),
    cursor: search.get('cursor'),
  });

  return ok(page);
});
