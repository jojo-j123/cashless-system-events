import { route } from '@/lib/api/handler';
import { ok } from '@/lib/api/responses';
import { challengeStatusSchema } from '@/lib/api/schemas';
import { setChallengeStatus } from '@/lib/services/challenges';
import { ValidationError } from '@/lib/errors';

export const PATCH = route(
  { permission: 'challenge.write', body: challengeStatusSchema },
  async ({ context, body, params }) => {
    const challengeId = params.id;
    if (!challengeId) throw new ValidationError('A challenge id is required.');

    await setChallengeStatus(
      context.db,
      { eventId: context.eventId, challengeId, status: body.status },
      context.audit,
    );

    return ok({ challengeId, status: body.status });
  },
);
