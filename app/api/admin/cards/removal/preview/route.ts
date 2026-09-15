import { route } from '@/lib/api/handler';
import { ok } from '@/lib/api/responses';
import { removalPreviewSchema } from '@/lib/api/schemas';
import { planCardRemoval } from '@/lib/services/removal';

/** What a bulk removal would do. Reads only — nothing is written here. */
export const POST = route(
  { permission: 'card.remove', body: removalPreviewSchema },
  async ({ context, body }) => {
    const plan = await planCardRemoval(context.db, {
      eventId: context.eventId,
      cardIds: body.ids,
    });
    return ok(plan);
  },
);
