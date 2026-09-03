import { and, eq, isNull } from 'drizzle-orm';
import { route } from '@/lib/api/handler';
import { ok } from '@/lib/api/responses';
import { stores } from '@/lib/db/schema';

export const GET = route({ permission: 'store.read' }, async ({ context }) => {
  const rows = await context.db
    .select({
      id: stores.id,
      name: stores.name,
      slug: stores.slug,
      description: stores.description,
      location: stores.location,
      isActive: stores.isActive,
      isOpen: stores.isOpen,
    })
    .from(stores)
    .where(and(eq(stores.eventId, context.eventId), isNull(stores.deletedAt)))
    .orderBy(stores.name);

  return ok({ data: rows });
});
