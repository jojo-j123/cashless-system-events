import { route } from '@/lib/api/handler';
import { ok } from '@/lib/api/responses';
import { countUnread, listNotifications, markNotificationsRead } from '@/lib/services/notifications';

export const GET = route({}, async ({ request, context }) => {
  const params = new URL(request.url).searchParams;
  const [data, unread] = await Promise.all([
    listNotifications(context.db, context.actor.userId, {
      unreadOnly: params.get('unread') === 'true',
      limit: Number(params.get('limit') ?? 50),
    }),
    countUnread(context.db, context.actor.userId),
  ]);
  return ok({ data, unread });
});

export const POST = route({}, async ({ context }) => {
  // Always the caller's own notifications: there is no id parameter to abuse.
  const marked = await markNotificationsRead(context.db, context.actor.userId);
  return ok({ marked });
});
