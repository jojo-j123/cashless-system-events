import { route } from '@/lib/api/handler';
import { ok } from '@/lib/api/responses';
import { listRedemptions, type RedemptionStatus } from '@/lib/services/rewards';

const STATUSES: RedemptionStatus[] = ['CLAIMED', 'FULFILLED', 'CANCELLED'];

export const GET = route({ permission: 'reward.read' }, async ({ request, context }) => {
  const params = new URL(request.url).searchParams;
  const status = params.get('status') as RedemptionStatus | null;

  // Without reward.fulfil this is your own history, not the event's. The scope
  // is decided here rather than trusted from a query parameter.
  const canSeeEveryone = context.actor.can('reward.fulfil', { eventId: context.eventId });

  return ok({
    data: await listRedemptions(context.db, context.eventId, {
      ...(status && STATUSES.includes(status) ? { status } : {}),
      ...(canSeeEveryone ? {} : { userId: context.actor.userId }),
    }),
  });
});
