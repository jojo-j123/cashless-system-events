import { route } from '@/lib/api/handler';
import { ok } from '@/lib/api/responses';
import { getEventOverview, getPointsTimeSeries } from '@/lib/services/reports';

export const GET = route({ permission: 'report.read' }, async ({ context }) => {
  const [overview, series] = await Promise.all([
    getEventOverview(context.db, context.eventId),
    getPointsTimeSeries(context.db, context.eventId),
  ]);
  return ok({ overview, series });
});
