import { and, desc, eq } from 'drizzle-orm';
import { requireSession } from '@/lib/auth/server';
import { eventParticipants, nfcCards, users } from '@/lib/db/schema';
import { CardManager } from '@/components/admin/CardManager';

export const metadata = { title: 'NFC cards · Admin' };
export const dynamic = 'force-dynamic';

export default async function CardsPage(): Promise<React.ReactElement> {
  const session = await requireSession('card.read');

  const cards = await session.db
    .select({
      id: nfcCards.id,
      cardRef: nfcCards.cardRef,
      status: nfcCards.status,
      technology: nfcCards.technology,
      batchLabel: nfcCards.batchLabel,
      lastUsedAt: nfcCards.lastUsedAt,
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
        eq(eventParticipants.eventId, session.eventId),
      ),
    )
    .where(eq(nfcCards.eventId, session.eventId))
    .orderBy(desc(nfcCards.updatedAt))
    .limit(200);

  return (
    <CardManager
      cards={cards.map((card) => ({
        ...card,
        lastUsedAt: card.lastUsedAt ? card.lastUsedAt.toISOString() : null,
      }))}
      canAssign={session.actor.can('card.assign', { eventId: session.eventId })}
      canSuspend={session.actor.can('card.suspend', { eventId: session.eventId })}
      canReplace={session.actor.can('card.replace', { eventId: session.eventId })}
      canCreate={session.actor.can('card.write', { eventId: session.eventId })}
    />
  );
}
