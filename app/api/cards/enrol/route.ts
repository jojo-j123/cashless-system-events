import { route } from '@/lib/api/handler';
import { created } from '@/lib/api/responses';
import { enrolCardSchema } from '@/lib/api/schemas';
import { enrolParticipantCard } from '@/lib/services/enrolment';

/**
 * Enrol a participant and their tag in one step.
 *
 * Gated on `wallet.topup` rather than `card.write`: this endpoint mints points,
 * and that is the highest privilege it exercises. The other two capabilities it
 * uses are required explicitly below, so holding the money permission alone is
 * not enough to create people or cards through it.
 */
export const POST = route(
  { permission: 'wallet.topup', body: enrolCardSchema, idempotent: true },
  async ({ context, body, idempotencyKey }) => {
    const scope = { eventId: context.eventId };
    context.actor.require('participant.write', scope);
    context.actor.require('card.write', scope);

    const result = await enrolParticipantCard(
      context.db,
      {
        eventId: context.eventId,
        displayName: body.displayName,
        teamId: body.teamId ?? null,
        uid: body.uid,
        topUpPoints: body.topUpPoints ?? 0,
        createdBy: context.actor.userId,
      },
      idempotencyKey,
      context.audit,
    );

    return created(result);
  },
);
