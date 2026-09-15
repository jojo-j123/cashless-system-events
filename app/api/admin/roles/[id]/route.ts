import { route } from '@/lib/api/handler';
import { noContent, ok } from '@/lib/api/responses';
import { rolePermissionsSchema } from '@/lib/api/schemas';
import { deleteRole, resetRoleToDefaults, setRolePermissions } from '@/lib/services/roles';
import { ForbiddenError, ValidationError } from '@/lib/errors';
import type { RequestContext } from '@/lib/api/context';

function requireOwner(context: RequestContext): void {
  if (!context.actor.isSuperAdmin) {
    throw new ForbiddenError('Only a super admin can manage roles.');
  }
}

function roleId(params: Record<string, string>): string {
  const id = params.id;
  if (!id) throw new ValidationError('No role was named.');
  return id;
}

/** Replace what a role may do. `?reset=1` hands a shipped role back to its defaults. */
export const PATCH = route(
  { body: rolePermissionsSchema },
  async ({ request, context, body, params }) => {
    requireOwner(context);
    const id = roleId(params);

    if (new URL(request.url).searchParams.get('reset') === '1') {
      return ok(await resetRoleToDefaults(context.db, id, context.audit));
    }

    return ok(
      await setRolePermissions(
        context.db,
        { roleId: id, permissions: body.permissions },
        context.audit,
      ),
    );
  },
);

export const DELETE = route({}, async ({ context, params }) => {
  requireOwner(context);
  await deleteRole(context.db, roleId(params), context.audit);
  return noContent();
});
