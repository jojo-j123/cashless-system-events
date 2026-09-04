import { route } from '@/lib/api/handler';
import { ok } from '@/lib/api/responses';
import { cardStatusSchema } from '@/lib/api/schemas';
import { changeCardStatus, unassignCard } from '@/lib/services/cards';
import { ValidationError } from '@/lib/errors';

export const POST = route(
  { permission: 'card.suspend', body: cardStatusSchema },
  async ({ context, body, params }) => {
    const cardId = params.id;
    if (!cardId) throw new ValidationError('A card id is required.');

    await changeCardStatus(
      context.db,
      { eventId: context.eventId, cardId, status: body.status, reason: body.reason },
      context.audit,
    );
    return ok({ cardId, status: body.status });
  },
);

export const DELETE = route({ permission: 'card.assign' }, async ({ context, params }) => {
  const cardId = params.id;
  if (!cardId) throw new ValidationError('A card id is required.');

  await unassignCard(
    context.db,
    { eventId: context.eventId, cardId, reason: 'Unassigned by staff' },
    context.audit,
  );
  return ok({ cardId, status: 'UNASSIGNED' });
});
