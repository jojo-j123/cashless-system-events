import { eq } from 'drizzle-orm';
import { route } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/responses';
import { topUpUserSchema } from '@/lib/api/schemas';
import { topUpUser } from '@/lib/services/wallet';
import { getEventSettings } from '@/lib/settings/service';
import { users } from '@/lib/db/schema';
import { verifyPin } from '@/lib/auth/password';
import { ForbiddenError } from '@/lib/errors';

export const POST = route(
  { permission: 'wallet.topup', body: topUpUserSchema, idempotent: true },
  async ({ context, body, idempotencyKey }) => {
    const settings = await getEventSettings(context.db, context.eventId);

    // A second factor for high-value counter top-ups: knowing the session is
    // not the same as being the person authorised to issue this much.
    if (
      settings.pinRequiredAboveTopUp > 0 &&
      body.amountPoints >= settings.pinRequiredAboveTopUp
    ) {
      const [staff] = await context.db
        .select({ pinHash: users.pinHash })
        .from(users)
        .where(eq(users.id, context.actor.userId))
        .limit(1);

      if (!staff?.pinHash) {
        throw new ForbiddenError(
          `Top-ups of ${settings.pinRequiredAboveTopUp.toLocaleString()} points or more need a staff PIN, and none is set on your account.`,
        );
      }
      if (!body.pin || !(await verifyPin(body.pin, staff.pinHash))) {
        throw new ForbiddenError('That PIN is not correct.');
      }
    }

    const { result, replayed } = await topUpUser(
      context.db,
      {
        eventId: context.eventId,
        userId: body.userId,
        amountPoints: body.amountPoints,
        reason: body.reason,
        source: body.source,
        terminalId: body.terminalId ?? null,
        createdBy: context.actor.userId,
      },
      idempotencyKey,
      context.audit,
    );

    return replayed ? ok(result) : created(result);
  },
);
