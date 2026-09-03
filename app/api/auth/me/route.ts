import { eq } from 'drizzle-orm';
import { route } from '@/lib/api/handler';
import { ok } from '@/lib/api/responses';
import { events, users } from '@/lib/db/schema';

export const GET = route({}, async ({ context }) => {
  const [user] = await context.db
    .select({
      id: users.id,
      displayName: users.displayName,
      email: users.email,
      avatarUrl: users.avatarUrl,
    })
    .from(users)
    .where(eq(users.id, context.actor.userId))
    .limit(1);

  const [event] = await context.db
    .select({ id: events.id, name: events.name, slug: events.slug, status: events.status })
    .from(events)
    .where(eq(events.id, context.eventId))
    .limit(1);

  return ok({
    user,
    event,
    roles: context.actor.roleKeys,
    permissions: context.actor.permissionList(),
    isSuperAdmin: context.actor.isSuperAdmin,
  });
});
