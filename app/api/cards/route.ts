import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { route } from '@/lib/api/handler';
import { ok } from '@/lib/api/responses';
import { eventParticipants, nfcCards, users } from '@/lib/db/schema';

export const GET = route({ permission: 'card.read' }, async ({ request, context }) => {
  const params = new URL(request.url).searchParams;
  const status = params.get('status');
  const search = params.get('q')?.trim();
  const limit = Math.min(Number(params.get('limit') ?? 50), 200);

  const conditions = [eq(nfcCards.eventId, context.eventId)];
  if (status) conditions.push(sql`${nfcCards.status}::text = ${status}`);
  if (search) {
    const pattern = `%${search}%`;
    const match = or(
      ilike(nfcCards.cardRef, pattern),
      ilike(users.displayName, pattern),
      ilike(eventParticipants.participantRef, pattern),
    );
    if (match) conditions.push(match);
  }

  const rows = await context.db
    .select({
      id: nfcCards.id,
      cardRef: nfcCards.cardRef,
      status: nfcCards.status,
      technology: nfcCards.technology,
      batchLabel: nfcCards.batchLabel,
      lastUsedAt: nfcCards.lastUsedAt,
      assignedAt: nfcCards.assignedAt,
      userId: users.id,
      displayName: users.displayName,
      participantRef: eventParticipants.participantRef,
    })
    .from(nfcCards)
    .leftJoin(users, eq(users.id, nfcCards.assignedUserId))
    .leftJoin(
      eventParticipants,
      and(
        eq(eventParticipants.userId, nfcCards.assignedUserId),
        eq(eventParticipants.eventId, context.eventId),
      ),
    )
    .where(and(...conditions))
    .orderBy(desc(nfcCards.updatedAt))
    .limit(limit);

  return ok({ data: rows });
});
