import { route } from '@/lib/api/handler';
import { ok } from '@/lib/api/responses';
import { listStock } from '@/lib/services/inventory';

export const GET = route({ permission: 'inventory.read' }, async ({ request, context }) => {
  const params = new URL(request.url).searchParams;
  const storeId = params.get('storeId') ?? undefined;
  const stock = await listStock(context.db, context.eventId, {
    ...(storeId ? { storeId } : {}),
    lowOnly: params.get('low') === 'true',
  });
  return ok({ data: stock });
});
