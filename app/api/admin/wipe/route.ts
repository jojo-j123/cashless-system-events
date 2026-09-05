import { route } from '@/lib/api/handler';
import { ok } from '@/lib/api/responses';
import { wipeTenantSchema } from '@/lib/api/schemas';
import { wipeTenantData } from '@/lib/services/tenancy';
import { ForbiddenError } from '@/lib/errors';

/**
 * Empty the system for the next client.
 *
 * Super admin only, and deliberately not expressed as a permission: no role
 * should be able to acquire this by being granted something that sounds
 * adjacent to it.
 */
export const POST = route({ body: wipeTenantSchema }, async ({ context }) => {
  if (!context.actor.isSuperAdmin) {
    throw new ForbiddenError('Only a super admin can reset the system.');
  }

  const summary = await wipeTenantData(
    context.db,
    { actorUserId: context.actor.userId },
    context.audit,
  );

  return ok(summary);
});
