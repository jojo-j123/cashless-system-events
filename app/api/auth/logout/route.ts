import { cookies } from 'next/headers';
import { route } from '@/lib/api/handler';
import { noContent } from '@/lib/api/responses';
import { CSRF_COOKIE, SESSION_COOKIE, revokeSession } from '@/lib/auth/session';
import { recordAudit } from '@/lib/audit';

export const POST = route({}, async ({ context }) => {
  await revokeSession(context.db, context.sessionId, 'user signed out');
  await recordAudit(context.db, { ...context.audit, action: 'auth.logout' });

  const cookieBag = await cookies();
  cookieBag.delete(SESSION_COOKIE);
  cookieBag.delete(CSRF_COOKIE);

  return noContent();
});
