import { route } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/responses';
import { challengeCreateSchema } from '@/lib/api/schemas';
import { createChallenge, listChallenges } from '@/lib/services/challenges';
import { getEventSettings } from '@/lib/settings/service';
import { NotFoundError } from '@/lib/errors';

export const GET = route({ permission: 'challenge.read' }, async ({ context }) => {
  const settings = await getEventSettings(context.db, context.eventId);
  if (!settings.gameModeEnabled) throw new NotFoundError('Challenges for this event');

  return ok({ data: await listChallenges(context.db, context.eventId) });
});

export const POST = route(
  { permission: 'challenge.write', body: challengeCreateSchema },
  async ({ context, body }) => {
    // The service refuses this on a normal event too; the gate is not left to
    // the route, because a challenge is a way to create points.
    const result = await createChallenge(
      context.db,
      {
        eventId: context.eventId,
        name: body.name,
        slug: body.slug,
        description: body.description ?? null,
        rewardPoints: body.rewardPoints,
        rewardScorePoints: body.rewardScorePoints,
        maxCompletionsPerUser: body.maxCompletionsPerUser,
        startsAt: body.startsAt ?? null,
        endsAt: body.endsAt ?? null,
      },
      context.audit,
    );

    return created(result);
  },
);
