import { route } from '@/lib/api/handler';
import { ok } from '@/lib/api/responses';
import { getTeamLeaderboard } from '@/lib/services/reports';
import { getEventSettings } from '@/lib/settings/service';
import { NotFoundError } from '@/lib/errors';

export const GET = route({ permission: 'team.read' }, async ({ context }) => {
  const settings = await getEventSettings(context.db, context.eventId);

  // This returns ranked standings, not a roster. A normal event has neither.
  if (!settings.gameModeEnabled) throw new NotFoundError('Teams for this event');

  return ok({ data: await getTeamLeaderboard(context.db, context.eventId, settings.teamRankingMetric) });
});
