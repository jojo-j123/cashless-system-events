import { route } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/responses';
import { roleCreateSchema } from '@/lib/api/schemas';
import { createRole, listRoles, permissionCatalogue } from '@/lib/services/roles';
import { ForbiddenError } from '@/lib/errors';
import type { RequestContext } from '@/lib/api/context';

/**
 * Roles are owner territory.
 *
 * Gated on the super admin flag rather than a permission, for the same reason
 * the wipe and credentials routes are: `role.manage` is itself something a role
 * could be given, and a screen that hands out authority must not be reachable
 * by being handed authority.
 */
function requireOwner(context: RequestContext): void {
  if (!context.actor.isSuperAdmin) {
    throw new ForbiddenError('Only a super admin can manage roles.');
  }
}

export const GET = route({}, async ({ context }) => {
  requireOwner(context);
  return ok({ roles: await listRoles(context.db), permissions: permissionCatalogue() });
});

export const POST = route({ body: roleCreateSchema }, async ({ context, body }) => {
  requireOwner(context);
  const result = await createRole(
    context.db,
    {
      key: body.key,
      name: body.name,
      description: body.description ?? null,
      permissions: body.permissions,
    },
    context.audit,
  );
  return created(result);
});
