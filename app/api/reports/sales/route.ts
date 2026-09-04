import { route } from '@/lib/api/handler';
import { ok } from '@/lib/api/responses';
import { getSalesByStore } from '@/lib/services/reports';

export const GET = route({ permission: 'report.read' }, async ({ request, context }) => {
  const params = new URL(request.url).searchParams;
  const from = params.get('from');
  const to = params.get('to');

  return ok({
    data: await getSalesByStore(context.db, context.eventId, {
      from: from ? new Date(from) : null,
      to: to ? new Date(to) : null,
    }),
  });
});
