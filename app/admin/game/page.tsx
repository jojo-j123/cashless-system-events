import { notFound } from 'next/navigation';
import { requireSession } from '@/lib/auth/server';
import { getEventSettings } from '@/lib/settings/service';
import {
  getIndividualLeaderboard,
  getTeamLeaderboard,
  type IndividualMetric,
  type TeamMetric,
} from '@/lib/services/reports';
import { Card, EmptyState, Points } from '@/components/ui/primitives';

export const metadata = { title: 'Game · Cashless Event Platform' };
export const dynamic = 'force-dynamic';

const TEAM_METRIC_LABEL: Record<TeamMetric, string> = {
  TEAM_SCORE: 'Score',
  TOTAL_EARNED: 'Earned',
  TOTAL_SPENT: 'Spent',
  CURRENT_BALANCE: 'Balance',
};

const INDIVIDUAL_METRIC_LABEL: Record<IndividualMetric, string> = {
  CHALLENGE_POINTS: 'Score',
  TOTAL_EARNED: 'Earned',
  TOTAL_SPENT: 'Spent',
  CURRENT_BALANCE: 'Balance',
};

/**
 * Standings.
 *
 * Rendered on the server against the live ledger rather than fetched by the
 * browser: this is the screen most likely to end up on a projector, where a
 * client-side refresh loop is a liability and a stale number is worse than a
 * slow one.
 */
export default async function GamePage(): Promise<React.ReactElement> {
  const session = await requireSession('leaderboard.read');
  const settings = await getEventSettings(session.db, session.eventId);

  // Game mode off means this surface does not exist, not that it is empty.
  if (!settings.gameModeEnabled) notFound();

  const [teams, individuals] = await Promise.all([
    getTeamLeaderboard(session.db, session.eventId, settings.teamRankingMetric),
    getIndividualLeaderboard(session.db, session.eventId, settings.individualRankingMetric, 25),
  ]);

  const teamValue = (standing: (typeof teams)[number]): number =>
    settings.teamRankingMetric === 'TEAM_SCORE'
      ? standing.score
      : settings.teamRankingMetric === 'TOTAL_EARNED'
        ? standing.totalEarned
        : settings.teamRankingMetric === 'TOTAL_SPENT'
          ? standing.totalSpent
          : standing.walletBalance;

  const individualValue = (standing: (typeof individuals)[number]): number =>
    settings.individualRankingMetric === 'CHALLENGE_POINTS'
      ? standing.scorePoints
      : settings.individualRankingMetric === 'TOTAL_EARNED'
        ? standing.totalEarned
        : settings.individualRankingMetric === 'TOTAL_SPENT'
          ? standing.totalSpent
          : standing.balance;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-ink-900">Game</h1>
        <p className="mt-1 text-sm text-ink-500">
          Ranked by {TEAM_METRIC_LABEL[settings.teamRankingMetric].toLowerCase()} for teams,{' '}
          {INDIVIDUAL_METRIC_LABEL[settings.individualRankingMetric].toLowerCase()} for players.
        </p>
      </div>

      <section>
        <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-ink-500">Teams</h2>
        {teams.length === 0 ? (
          <EmptyState title="No teams" description="Create teams to start scoring." />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {teams.map((team) => (
              <Card key={team.teamId} className="flex items-center gap-4">
                <span
                  aria-hidden
                  className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-lg font-bold text-white"
                  style={{ backgroundColor: team.color }}
                >
                  {team.rank}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold text-ink-900">{team.name}</span>
                  <span className="block text-xs text-ink-500">
                    {team.members} {team.members === 1 ? 'player' : 'players'}
                  </span>
                </span>
                <Points value={teamValue(team)} size="lg" />
              </Card>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-ink-500">Players</h2>
        {individuals.length === 0 ? (
          <EmptyState title="Nothing scored yet" description="Standings appear after the first points move." />
        ) : (
          <Card padded={false}>
            <ul className="divide-y divide-ink-100">
              {individuals.map((player) => (
                <li key={player.userId} className="flex items-center gap-3 px-4 py-2.5">
                  <span className="tabular w-8 shrink-0 text-sm font-bold text-ink-400">
                    {player.rank}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-ink-900">
                      {player.displayName}
                    </span>
                    {player.teamName ? (
                      <span className="block text-xs text-ink-500">{player.teamName}</span>
                    ) : null}
                  </span>
                  <Points value={individualValue(player)} />
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>
    </div>
  );
}
