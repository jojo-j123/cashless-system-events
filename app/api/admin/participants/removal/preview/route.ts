import { route } from '@/lib/api/handler';
import { ok } from '@/lib/api/responses';
import { removalPreviewSchema } from '@/lib/api/schemas';
import { planParticipantRemoval } from '@/lib/services/removal';

/** What a bulk removal would do, including the points it would write off. */
export const POST = route(
  { permission: 'participant.remove', body: removalPreviewSchema },
  async ({ context, body }) => {
    const plan = await planParticipantRemoval(context.db, {
      eventId: context.eventId,
      userIds: body.ids,
      actorUserId: context.actor.userId,
    });
    return ok(plan);
  },
);
