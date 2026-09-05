import { route } from '@/lib/api/handler';
import { ok } from '@/lib/api/responses';
import { setAccountCredentialsSchema } from '@/lib/api/schemas';
import { setAccountCredentials } from '@/lib/services/tenancy';
import { ForbiddenError } from '@/lib/errors';

/**
 * Set a staff account's email or password.
 *
 * Super admin only, and gated on the flag rather than a permission: handing
 * out logins is ownership of the system, not an operational task, and no role
 * should acquire it by being granted something that sounds adjacent.
 */
export const POST = route({ body: setAccountCredentialsSchema }, async ({ context, body }) => {
  if (!context.actor.isSuperAdmin) {
    throw new ForbiddenError('Only a super admin can set another account’s sign-in details.');
  }

  const result = await setAccountCredentials(
    context.db,
    {
      targetUserId: body.userId,
      actorUserId: context.actor.userId,
      newEmail: body.newEmail ?? null,
      newPassword: body.newPassword ?? null,
    },
    context.audit,
  );

  return ok(result);
});
