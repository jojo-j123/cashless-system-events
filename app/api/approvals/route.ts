import { and, desc, eq } from 'drizzle-orm';
import { route } from '@/lib/api/handler';
import { ok } from '@/lib/api/responses';
import { approvalRequests, users } from '@/lib/db/schema';

export const GET = route({ permission: 'approval.decide' }, async ({ request, context }) => {
  const status = new URL(request.url).searchParams.get('status') ?? 'PENDING_APPROVAL';

  const rows = await context.db
    .select({
      id: approvalRequests.id,
      type: approvalRequests.type,
      amountPoints: approvalRequests.amountPoints,
      payload: approvalRequests.payload,
      reason: approvalRequests.reason,
      status: approvalRequests.status,
      createdAt: approvalRequests.createdAt,
      requestedBy: approvalRequests.requestedBy,
      requesterName: users.displayName,
    })
    .from(approvalRequests)
    .innerJoin(users, eq(users.id, approvalRequests.requestedBy))
    .where(
      and(
        eq(approvalRequests.eventId, context.eventId),
        eq(approvalRequests.status, status as 'PENDING_APPROVAL'),
      ),
    )
    .orderBy(desc(approvalRequests.createdAt))
    .limit(100);

  return ok({ data: rows });
});
