import { route } from '@/lib/api/handler';
import { created } from '@/lib/api/responses';
import { cardBatchSchema } from '@/lib/api/schemas';
import { createCards } from '@/lib/services/cards';

export const POST = route(
  { permission: 'card.write', body: cardBatchSchema },
  async ({ context, body }) => {
    const cards = await createCards(
      context.db,
      {
        eventId: context.eventId,
        count: body.count,
        technology: body.technology,
        batchLabel: body.batchLabel ?? null,
      },
      context.audit,
    );

    // The tokens are returned exactly once, here, so they can be written to
    // the chips. They are stored only as hashes and can never be read back.
    return created({
      cards,
      warning: 'Card tokens are shown once. Write them to the chips now; they cannot be recovered.',
    });
  },
);
