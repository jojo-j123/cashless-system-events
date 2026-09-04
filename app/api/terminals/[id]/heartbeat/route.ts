import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { route } from '@/lib/api/handler';
import { ok } from '@/lib/api/responses';
import { terminals } from '@/lib/db/schema';
import { ValidationError } from '@/lib/errors';

const heartbeatSchema = z.object({
  appVersion: z.string().max(40).optional(),
  status: z.enum(['ONLINE', 'ERROR']).optional(),
});

/**
 * Terminal liveness. A POS posts this on a timer; the ops dashboard derives
 * ONLINE/ERROR/OFFLINE from how long ago the last one arrived.
 */
export const POST = route(
  { permission: 'pos.operate', body: heartbeatSchema },
  async ({ context, body, params }) => {
    const terminalId = params.id;
    if (!terminalId) throw new ValidationError('A terminal id is required.');

    await context.db
      .update(terminals)
      .set({
        lastHeartbeatAt: new Date(),
        ...(body.appVersion ? { appVersion: body.appVersion } : {}),
        assignedCashierUserId: context.actor.userId,
      })
      .where(and(eq(terminals.id, terminalId), eq(terminals.eventId, context.eventId)));

    return ok({ terminalId, acknowledgedAt: new Date().toISOString() });
  },
);
