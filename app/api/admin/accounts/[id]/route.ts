import { route } from '@/lib/api/handler';
import { noContent } from '@/lib/api/responses';
import { deleteStaffAccount } from '@/lib/services/tenancy';
import { ForbiddenError, ValidationError } from '@/lib/errors';

export const DELETE = route({}, async ({ context, params }) => {
  if (!context.actor.isSuperAdmin) {
    throw new ForbiddenError('Only a super admin can delete a staff login.');
  }
  const id = params.id;
  if (!id) throw new ValidationError('No account was named.');

  await deleteStaffAccount(
    context.db,
    { userId: id, actorUserId: context.actor.userId },
    context.audit,
  );
  return noContent();
});
