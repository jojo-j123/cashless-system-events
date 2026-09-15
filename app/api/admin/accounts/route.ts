import { route } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/responses';
import { staffCreateSchema, staffRoleSchema } from '@/lib/api/schemas';
import { createStaffAccount, setStaffRole } from '@/lib/services/tenancy';
import { ForbiddenError } from '@/lib/errors';
import type { RequestContext } from '@/lib/api/context';

function requireOwner(context: RequestContext): void {
  if (!context.actor.isSuperAdmin) {
    throw new ForbiddenError('Only a super admin can create staff logins.');
  }
}

/** Create a staff login: name, email, password, role. */
export const POST = route({ body: staffCreateSchema }, async ({ context, body }) => {
  requireOwner(context);
  const account = await createStaffAccount(
    context.db,
    {
      eventId: context.eventId,
      displayName: body.displayName,
      email: body.email,
      password: body.password,
      roleKey: body.roleKey,
      storeId: body.storeId ?? null,
      actorUserId: context.actor.userId,
    },
    context.audit,
  );
  return created(account);
});

/** Move an existing staff account onto a different role. */
export const PATCH = route({ body: staffRoleSchema }, async ({ context, body }) => {
  requireOwner(context);
  await setStaffRole(
    context.db,
    {
      eventId: context.eventId,
      userId: body.userId,
      roleKey: body.roleKey,
      storeId: body.storeId ?? null,
      actorUserId: context.actor.userId,
    },
    context.audit,
  );
  return ok({ userId: body.userId, roleKey: body.roleKey });
});
