import { and, desc, eq } from 'drizzle-orm';
import { requireSession } from '@/lib/auth/server';
import { getWalletSummary, getWalletTransactions } from '@/lib/services/wallet';
import { getTeamLeaderboard } from '@/lib/services/reports';
import { getEventSettings } from '@/lib/settings/service';
import { eventParticipants, nfcCards, teamMembers, teams, users } from '@/lib/db/schema';
import { ParticipantDashboard } from '@/components/participant/ParticipantDashboard';

export const metadata = { title: 'My wallet · Cashless Event Platform' };
export const dynamic = 'force-dynamic';

export default async function ParticipantPage(): Promise<React.ReactElement> {
  const session = await requireSession('wallet.read.self');
  const userId = session.actor.userId;

  const [wallet, settings] = await Promise.all([
    getWalletSummary(session.db, session.eventId, userId),
    getEventSettings(session.db, session.eventId),
  ]);

  const [profile] = await session.db
    .select({
      displayName: users.displayName,
      participantRef: eventParticipants.participantRef,
      teamId: teams.id,
      teamName: teams.name,
      teamColor: teams.color,
    })
    .from(eventParticipants)
    .innerJoin(users, eq(users.id, eventParticipants.userId))
    .leftJoin(
      teamMembers,
      and(eq(teamMembers.userId, users.id), eq(teamMembers.eventId, session.eventId)),
    )
    .leftJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(
      and(eq(eventParticipants.eventId, session.eventId), eq(eventParticipants.userId, userId)),
    )
    .limit(1);

  const [card] = await session.db
    .select({ cardRef: nfcCards.cardRef, status: nfcCards.status })
    .from(nfcCards)
    .where(
      and(
        eq(nfcCards.eventId, session.eventId),
        eq(nfcCards.assignedUserId, userId),
        eq(nfcCards.status, 'ACTIVE'),
      ),
    )
    .orderBy(desc(nfcCards.assignedAt))
    .limit(1);

  const [history, standings] = await Promise.all([
    getWalletTransactions(session.db, wallet.accountId, { limit: 20 }),
    settings.leaderboardVisibleToParticipants
      ? getTeamLeaderboard(session.db, session.eventId, settings.teamRankingMetric)
      : Promise.resolve([]),
  ]);

  const teamStanding = standings.find((standing) => standing.teamId === profile?.teamId) ?? null;

  return (
    <ParticipantDashboard
      displayName={profile?.displayName ?? 'Participant'}
      participantRef={profile?.participantRef ?? ''}
      eventName={session.eventName}
      wallet={wallet}
      card={card ?? null}
      team={
        profile?.teamId
          ? {
              name: profile.teamName ?? '',
              color: profile.teamColor ?? '#475569',
              rank: teamStanding?.rank ?? null,
              score: teamStanding?.score ?? 0,
              totalTeams: standings.length,
            }
          : null
      }
      transactions={history.entries}
      lowBalanceThreshold={settings.lowBalanceThreshold}
      transfersEnabled={settings.allowTransfers}
    />
  );
}
