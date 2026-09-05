import { and, eq, sql } from 'drizzle-orm';
import { requireSession } from '@/lib/auth/server';
import { accounts, eventParticipants, nfcCards, teamMembers, teams, users } from '@/lib/db/schema';
import { Badge, Card, EmptyState, Points } from '@/components/ui/primitives';

export const metadata = { title: 'Participants · Admin' };
export const dynamic = 'force-dynamic';

export default async function ParticipantsPage(): Promise<React.ReactElement> {
  const session = await requireSession('participant.read.any');

  const rows = await session.db
    .select({
      userId: users.id,
      displayName: users.displayName,
      email: users.email,
      status: users.status,
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
        <p className="text-sm text-ink-500">{rows.length} enrolled in {session.eventName}</p>
      </header>

      {rows.length === 0 ? (
        <EmptyState title="No participants" description="Nobody has been enrolled yet." />
      ) : (
        <Card padded={false}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
                <tr>
                  <th className="px-4 py-2">Participant</th>
                  <th className="px-4 py-2">Team</th>
                  <th className="hidden px-4 py-2 sm:table-cell">Card</th>
                  <th className="px-4 py-2 text-right">Balance</th>
                  <th className="hidden px-4 py-2 text-right sm:table-cell">Earned</th>
                  <th className="hidden px-4 py-2 text-right sm:table-cell">Spent</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-200">
                {rows.map((row) => (
                  <tr key={row.userId}>
                    <td className="px-4 py-3">
                      <p className="font-medium text-ink-900">{row.displayName}</p>
                      <p className="tabular text-xs text-ink-400">
                        {row.participantRef}
                        {row.email ? ` · ${row.email}` : ''}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      {row.teamName ? (
                        <span className="inline-flex items-center gap-2">
                          <span
                            aria-hidden
                            className="h-2.5 w-2.5 rounded-full"
                            style={{ backgroundColor: row.teamColor ?? '#475569' }}
                          />
                          {row.teamName}
                        </span>
                      ) : (
                        <span className="text-ink-400">—</span>
                      )}
                    </td>
                    <td className="tabular hidden px-4 py-3 text-xs sm:table-cell">
                      {row.cardRef ?? <Badge tone="warn">No card</Badge>}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Points value={row.balance} />
                    </td>
                    <td className="tabular hidden px-4 py-3 text-right text-ink-500 sm:table-cell">
                      {row.lifetimeEarned.toLocaleString()}
                    </td>
                    <td className="tabular hidden px-4 py-3 text-right text-ink-500 sm:table-cell">
                      {row.lifetimeSpent.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
