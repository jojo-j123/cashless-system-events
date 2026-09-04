import { route } from '@/lib/api/handler';
import { ok } from '@/lib/api/responses';
import { getCardHistory } from '@/lib/services/cards';
import { ValidationError } from '@/lib/errors';

export const GET = route({ permission: 'card.read' }, async ({ context, params }) => {
  const cardId = params.id;
  if (!cardId) throw new ValidationError('A card id is required.');
  return ok({ data: await getCardHistory(context.db, cardId) });
});
