import { route } from '@/lib/api/handler';
import { created } from '@/lib/api/responses';
import { transferSchema } from '@/lib/api/schemas';
import { transferPoints } from '@/lib/services/wallet';
import { RATE_LIMITS } from '@/lib/core/rate-limit';

export const POST = route(
  {
    permission: 'wallet.transfer.self',
    body: transferSchema,
    idempotent: true,
    rateLimit: RATE_LIMITS.transfer,
  },
  async ({ context, body, idempotencyKey }) => {
    const result = await transferPoints(
      context.db,
      {
        eventId: context.eventId,
        // Always the signed-in user: a transfer cannot be initiated on someone
        // else's behalf by passing a different id.
        fromUserId: context.actor.userId,
        toUserId: body.toUserId,
        amountPoints: body.amountPoints,
        note: body.note ?? null,
      },
      idempotencyKey,
      context.audit,
    );
    return created(result);
  },
);
