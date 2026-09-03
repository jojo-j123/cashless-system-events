import { route } from '@/lib/api/handler';
import { ok } from '@/lib/api/responses';
import { cardReplaceSchema } from '@/lib/api/schemas';
import { replaceCard } from '@/lib/services/cards';

export const POST = route(
  { permission: 'card.replace', body: cardReplaceSchema },
  async ({ context, body }) => {
    const result = await replaceCard(
      context.db,
      {
        eventId: context.eventId,
        oldCardId: body.oldCardId,
        newCardId: body.newCardId,
        reason: body.reason,
        retireAs: body.retireAs,
      },
      context.audit,
    );
    // The wallet is untouched by design — the money never lived on the card.
    return ok({ ...result, oldCardId: body.oldCardId, newCardId: body.newCardId });
  },
);
