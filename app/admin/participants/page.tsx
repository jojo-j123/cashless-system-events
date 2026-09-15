import { and, eq, sql } from 'drizzle-orm';
import { requireSession } from '@/lib/auth/server';
import { accounts, eventParticipants, nfcCards, teamMembers, teams, users } from '@/lib/db/schema';
import { ParticipantManager } from '@/components/admin/ParticipantManager';

export const metadata = { title: 'Participants · Admin' };
export const dynamic = 'force-dynamic';

export default async function ParticipantsPage(): Promise<React.ReactElement> {
  const session = await requireSession('participant.read.any');

  const rows = await session.db
    .select({
      userId: users.id,
      displayName: users.displayName,
      email: users.email,
      participantRef: eventParticipants.participantRef,
      teamName: teams.name,
      teamColor: teams.color,
      balance: accounts.balance,
      lifetimeEarned: accounts.lifetimeCredited,
      lifetimeSpent: accounts.lifetimeDebited,
      cardRef: nfcCards.cardRef,
    })
    .from(eventParticipants)
    .innerJoin(users, eq(users.id, eventParticipants.userId))
    .innerJoin(
      accounts,
      and(
        eq(accounts.ownerUserId, users.id),
        eq(accounts.eventId, session.eventId),
        eq(accounts.type, 'USER_SPENDABLE'),
      ),
    )
    .leftJoin(
      teamMembers,
      and(eq(teamMembers.userId, users.id), eq(teamMembers.eventId, session.eventId)),
    )
    .leftJoin(teams, eq(teams.id, teamMembers.teamId))
    .leftJoin(
      nfcCards,
      and(
        eq(nfcCards.assignedUserId, users.id),
        eq(nfcCards.eventId, session.eventId),
        sql`${nfcCards.status} = 'ACTIVE'`,
      ),
    )
    .where(eq(eventParticipants.eventId, session.eventId))
    .orderBy(users.displayName)
    .limit(500);

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-bold text-ink-900">Participants</h1>
        <p className="text-sm text-ink-500">
          {rows.length} enrolled in {session.eventName}
        </p>
      </header>

      <ParticipantManager
        rows={rows}
        canRemove={session.actor.can('participant.remove', { eventId: session.eventId })}
      />
    </div>
  );
}
