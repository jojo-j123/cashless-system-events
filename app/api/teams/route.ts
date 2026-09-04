import { route } from '@/lib/api/handler';
import { ok } from '@/lib/api/responses';
import { getTeamLeaderboard } from '@/lib/services/reports';
import { getEventSettings } from '@/lib/settings/service';

export const GET = route({ permission: 'team.read' }, async ({ context }) => {
  const settings = await getEventSettings(context.db, context.eventId);
  return ok({ data: await getTeamLeaderboard(context.db, context.eventId, settings.teamRankingMetric) });
});
