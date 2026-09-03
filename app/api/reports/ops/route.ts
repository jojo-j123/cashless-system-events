import { route } from '@/lib/api/handler';
import { ok } from '@/lib/api/responses';
import { getOpsSnapshot } from '@/lib/services/reports';

export const GET = route({ permission: 'ops.dashboard' }, async ({ context }) => {
  return ok(await getOpsSnapshot(context.db, context.eventId));
});
