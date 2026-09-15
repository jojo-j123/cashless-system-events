import { route } from '@/lib/api/handler';
import { ok } from '@/lib/api/responses';
import { rewardPatchSchema } from '@/lib/api/schemas';
import { updateReward } from '@/lib/services/rewards';
import { ValidationError } from '@/lib/errors';

export const PATCH = route(
  { permission: 'reward.write', body: rewardPatchSchema },
  async ({ context, body, params }) => {
    const rewardId = params.id;
    if (!rewardId) throw new ValidationError('A reward id is required.');

    await updateReward(
      context.db,
      {
        eventId: context.eventId,
        rewardId,
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.costPoints !== undefined ? { costPoints: body.costPoints } : {}),
        ...(body.stock !== undefined ? { stock: body.stock } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      },
      context.audit,
    );

    return ok({ rewardId });
  },
);
