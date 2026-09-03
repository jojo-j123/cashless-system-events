import { route } from '@/lib/api/handler';
import { ok } from '@/lib/api/responses';
import { adjustSchema } from '@/lib/api/schemas';
import { adjustWallet } from '@/lib/services/wallet';

export const POST = route(
  { permission: 'wallet.adjust', body: adjustSchema, idempotent: true },
  async ({ context, body, idempotencyKey }) => {
    const result = await adjustWallet(
      context.db,
      {
        eventId: context.eventId,
        userId: body.userId,
        amountPoints: body.amountPoints,
        reason: body.reason,
        createdBy: context.actor.userId,
      },
      idempotencyKey,
      context.audit,
    );
    return ok(result);
  },
);
