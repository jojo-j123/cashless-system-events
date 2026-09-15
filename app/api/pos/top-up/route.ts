import { eq } from 'drizzle-orm';
import { route } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/responses';
import { posTopUpSchema } from '@/lib/api/schemas';
import { topUpAtTill } from '@/lib/services/wallet';
import { users } from '@/lib/db/schema';
import { verifyPin } from '@/lib/auth/password';
import { ForbiddenError } from '@/lib/errors';

/**
 * Take cash at the till for a customer who is short mid-sale.
 *
 * The PIN is required on every till top-up, not above a threshold as at the
 * admin counter. A signed-in terminal is shared by a shift; the PIN is what
 * makes each minted point attributable to the person who took the cash, and
 * that attribution is the only thing standing between this endpoint and a
 * cashier quietly funding their own card.
 *
 * The per-transaction ceiling lives in `topUpAtTill`, so it cannot be bypassed
 * by reaching the service from anywhere else.
 */
export const POST = route(
  {
    permission: 'wallet.topup.pos',
    body: posTopUpSchema,
    idempotent: true,
    // Scoped to the store in the body, exactly as a sale is: a cashier's
    // authority is the till they work, and taking cash is no broader than
    // ringing it up.
    scope: ({ context, body }) => ({ eventId: context.eventId, storeId: body.storeId }),
  },
  async ({ context, body, idempotencyKey }) => {
    const [staff] = await context.db
      .select({ pinHash: users.pinHash })
      .from(users)
      .where(eq(users.id, context.actor.userId))
      .limit(1);

    if (!staff?.pinHash) {
      throw new ForbiddenError(
        'Top-ups at the till need a staff PIN, and none is set on your account.',
      );
    }
    if (!(await verifyPin(body.pin, staff.pinHash))) {
      throw new ForbiddenError('That PIN is not correct.');
    }

    const { result, replayed } = await topUpAtTill(
      context.db,
      {
        eventId: context.eventId,
        userId: body.userId,
        amountPoints: body.amountPoints,
        terminalId: body.terminalId ?? null,
        createdBy: context.actor.userId,
      },
      idempotencyKey,
      context.audit,
    );

    return replayed ? ok(result) : created(result);
  },
);
