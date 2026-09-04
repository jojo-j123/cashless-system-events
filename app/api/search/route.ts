import { and, eq, ilike, or, sql } from 'drizzle-orm';
import { route } from '@/lib/api/handler';
import { ok } from '@/lib/api/responses';
import {
  eventParticipants,
  ledgerTransactions,
  nfcCards,
  purchases,
  teams,
  users,
} from '@/lib/db/schema';

interface SearchHit {
  type: 'participant' | 'card' | 'purchase' | 'transaction' | 'team';
  id: string;
  label: string;
  detail: string;
}

/**
 * Global admin search across the identifiers staff actually have to hand:
 * a name, an email, a card printed on a lanyard, a receipt reference someone
 * is holding up at the help desk.
 */
export const GET = route({ permission: 'participant.read.any' }, async ({ request, context }) => {
  const query = new URL(request.url).searchParams.get('q')?.trim() ?? '';
  if (query.length < 2) return ok({ data: [] });

  const pattern = `%${query}%`;
  const hits: SearchHit[] = [];

  const participantMatch = or(
    ilike(users.displayName, pattern),
    ilike(users.email, pattern),
    ilike(users.phone, pattern),
    ilike(eventParticipants.participantRef, pattern),
  );
  const people = await context.db
    .select({
      userId: users.id,
      displayName: users.displayName,
      email: users.email,
      participantRef: eventParticipants.participantRef,
    })
    .from(eventParticipants)
    .innerJoin(users, eq(users.id, eventParticipants.userId))
    .where(and(eq(eventParticipants.eventId, context.eventId), participantMatch ?? sql`true`))
    .limit(10);
  hits.push(
    ...people.map((row) => ({
      type: 'participant' as const,
      id: row.userId,
      label: row.displayName,
      detail: row.email ?? row.participantRef,
    })),
  );

  const cards = await context.db
    .select({ id: nfcCards.id, cardRef: nfcCards.cardRef, status: nfcCards.status })
    .from(nfcCards)
    .where(and(eq(nfcCards.eventId, context.eventId), ilike(nfcCards.cardRef, pattern)))
    .limit(10);
  hits.push(
    ...cards.map((row) => ({
      type: 'card' as const,
      id: row.id,
      label: row.cardRef,
      detail: row.status,
    })),
  );

  const receipts = await context.db
    .select({
      id: purchases.id,
      purchaseRef: purchases.purchaseRef,
      totalPoints: purchases.totalPoints,
    })
    .from(purchases)
    .where(and(eq(purchases.eventId, context.eventId), ilike(purchases.purchaseRef, pattern)))
    .limit(10);
  hits.push(
    ...receipts.map((row) => ({
      type: 'purchase' as const,
      id: row.id,
      label: row.purchaseRef,
      detail: `${row.totalPoints.toLocaleString()} points`,
    })),
  );

  if (context.actor.can('ledger.read', { eventId: context.eventId })) {
    const transactions = await context.db
      .select({
        id: ledgerTransactions.id,
        txnRef: ledgerTransactions.txnRef,
        type: ledgerTransactions.type,
      })
      .from(ledgerTransactions)
      .where(
        and(
          eq(ledgerTransactions.eventId, context.eventId),
          ilike(ledgerTransactions.txnRef, pattern),
        ),
      )
      .limit(10);
    hits.push(
      ...transactions.map((row) => ({
        type: 'transaction' as const,
        id: row.id,
        label: row.txnRef,
        detail: row.type,
      })),
    );
  }

  const teamRows = await context.db
    .select({ id: teams.id, name: teams.name })
    .from(teams)
    .where(and(eq(teams.eventId, context.eventId), ilike(teams.name, pattern)))
    .limit(5);
  hits.push(
    ...teamRows.map((row) => ({
      type: 'team' as const,
      id: row.id,
      label: row.name,
      detail: 'Team',
    })),
  );

  return ok({ data: hits });
});
