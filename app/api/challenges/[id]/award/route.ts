import { route } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/responses';
import { challengeAwardSchema } from '@/lib/api/schemas';
import { awardChallenge } from '@/lib/services/challenges';
import { ValidationError } from '@/lib/errors';

/**
 * Marking a challenge complete creates points, so it is a money endpoint: an
 * Idempotency-Key is mandatory, and a retried submission returns the original
 * award rather than paying a second time.
 */
export const POST = route(
  { permission: 'challenge.award', body: challengeAwardSchema, idempotent: true },
  async ({ context, body, params, idempotencyKey }) => {
    const challengeId = params.id;
    if (!challengeId) throw new ValidationError('A challenge id is required.');

    const { result, replayed } = await awardChallenge(
      context.db,
      {
        eventId: context.eventId,
        challengeId,
        userId: body.userId,
        awardedBy: context.actor.userId,
      },
      idempotencyKey,
      context.audit,
    );

    return replayed ? ok(result) : created(result);
  },
);
