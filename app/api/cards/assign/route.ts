import { route } from '@/lib/api/handler';
import { ok } from '@/lib/api/responses';
import { cardAssignSchema } from '@/lib/api/schemas';
import { assignCard } from '@/lib/services/cards';

export const POST = route(
  { permission: 'card.assign', body: cardAssignSchema },
  async ({ context, body }) => {
    await assignCard(
      context.db,
      { eventId: context.eventId, cardId: body.cardId, userId: body.userId },
      context.audit,
    );
    return ok({ cardId: body.cardId, userId: body.userId, status: 'ACTIVE' });
  },
);
