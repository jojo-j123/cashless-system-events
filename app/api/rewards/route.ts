import { route } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/responses';
import { rewardCreateSchema } from '@/lib/api/schemas';
import { createReward, listRewards } from '@/lib/services/rewards';

export const GET = route({ permission: 'reward.read' }, async ({ context }) => {
  // Participants see the catalogue they can actually spend on; staff see the
  // retired ones too, because that is what "edit rewards" needs.
  const staff = context.actor.can('reward.write', { eventId: context.eventId });
  return ok({
    data: await listRewards(context.db, context.eventId, { activeOnly: !staff }),
  });
});

export const POST = route(
  { permission: 'reward.write', body: rewardCreateSchema },
  async ({ context, body }) => {
    const result = await createReward(
      context.db,
      {
        eventId: context.eventId,
        name: body.name,
        description: body.description ?? null,
        type: body.type,
        costPoints: body.costPoints,
        stock: body.stock ?? null,
        productId: body.productId ?? null,
      },
      context.audit,
    );

    return created(result);
  },
);
