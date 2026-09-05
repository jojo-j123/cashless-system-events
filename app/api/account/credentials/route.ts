import { route } from '@/lib/api/handler';
import { ok } from '@/lib/api/responses';
import { changeCredentialsSchema } from '@/lib/api/schemas';
import { changeOwnCredentials } from '@/lib/services/tenancy';
import { RATE_LIMITS } from '@/lib/core/rate-limit';

/**
 * Change your own email address or password.
 *
 * No permission beyond being signed in: this only ever acts on the caller's own
 * account, and the current password is verified inside the service.
 */
export const POST = route(
  { body: changeCredentialsSchema, rateLimit: RATE_LIMITS.login },
  async ({ context, body }) => {
    await changeOwnCredentials(
      context.db,
      {
        userId: context.actor.userId,
        currentPassword: body.currentPassword,
        newEmail: body.newEmail ?? null,
        newPassword: body.newPassword ?? null,
      },
      context.audit,
    );
    return ok({ changed: true });
  },
);
