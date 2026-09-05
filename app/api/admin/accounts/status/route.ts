import { route } from '@/lib/api/handler';
import { ok } from '@/lib/api/responses';
import { accountStatusSchema } from '@/lib/api/schemas';
import { setUserStatus } from '@/lib/services/tenancy';

/** Suspend or restore a staff account, cutting its live sessions with it. */
export const POST = route(
  { permission: 'role.manage', body: accountStatusSchema },
  async ({ context, body }) => {
    await setUserStatus(
      context.db,
      { userId: body.userId, status: body.status, actorUserId: context.actor.userId },
      context.audit,
    );
    return ok({ userId: body.userId, status: body.status });
  },
);
