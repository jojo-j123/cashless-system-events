import { route } from '@/lib/api/handler';
import { ok } from '@/lib/api/responses';
import { getTopProducts } from '@/lib/services/reports';

export const GET = route({ permission: 'report.read' }, async ({ request, context }) => {
  const params = new URL(request.url).searchParams;
  const storeId = params.get('storeId');
  const from = params.get('from');
  const to = params.get('to');

  return ok({
    data: await getTopProducts(context.db, context.eventId, {
      ...(storeId ? { storeId } : {}),
      from: from ? new Date(from) : null,
      to: to ? new Date(to) : null,
      limit: Number(params.get('limit') ?? 20),
    }),
  });
});
