import { route } from '@/lib/api/handler';
import { ok } from '@/lib/api/responses';
import {
  getIndividualLeaderboard,
  getTeamLeaderboard,
  type IndividualMetric,
  type TeamMetric,
} from '@/lib/services/reports';
import { getEventSettings } from '@/lib/settings/service';
import { ForbiddenError } from '@/lib/errors';

export const GET = route({ permission: 'leaderboard.read' }, async ({ request, context }) => {
  const settings = await getEventSettings(context.db, context.eventId);

  // Operators can hide standings from participants without hiding them from staff.
  if (
    !settings.leaderboardVisibleToParticipants &&
    !context.actor.can('report.read', { eventId: context.eventId })
  ) {
    throw new ForbiddenError('Leaderboards are hidden for this event.');
  }

  const params = new URL(request.url).searchParams;
  const teamMetric = (params.get('teamMetric') ?? settings.teamRankingMetric) as TeamMetric;
  const individualMetric = (params.get('individualMetric') ??
    settings.individualRankingMetric) as IndividualMetric;

  const [teams, individuals] = await Promise.all([
    getTeamLeaderboard(context.db, context.eventId, teamMetric),
    getIndividualLeaderboard(context.db, context.eventId, individualMetric, 25),
  ]);

  return ok({ teams, individuals, teamMetric, individualMetric });
});
