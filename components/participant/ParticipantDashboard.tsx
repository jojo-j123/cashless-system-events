'use client';

import type { WalletSummary } from '@/lib/services/wallet';
import { Alert, Badge, Card, Points } from '@/components/ui/primitives';
import { SignOutButton } from '@/components/auth/SignOutButton';

interface LedgerRow {
  entryId: string;
  txnRef: string;
  type: string;
  amount: number;
  balanceAfter: number;
  reason: string;
  createdAt: string;
}

interface TeamInfo {
  name: string;
  color: string;
  rank: number | null;
  score: number;
  totalTeams: number;
}

const TYPE_LABELS: Record<string, string> = {
  TOP_UP: 'Points added',
  TEAM_ALLOCATION: 'Team allocation',
  BONUS: 'Bonus',
  CHALLENGE_REWARD: 'Challenge reward',
  PURCHASE: 'Purchase',
  REFUND: 'Refund',
  MANUAL_ADJUSTMENT: 'Adjustment',
  TRANSFER: 'Transfer',
  REVERSAL: 'Reversal',
  REWARD_REDEMPTION: 'Reward',
  SCORE_AWARD: 'Score award',
};

/**
 * Mobile-first participant view. The balance is the hero: it is the one number
 * a participant checks over and over during an event.
 */
export function ParticipantDashboard({
  displayName,
  participantRef,
  eventName,
  wallet,
  card,
  team,
  transactions,
  lowBalanceThreshold,
  transfersEnabled,
}: {
  displayName: string;
  participantRef: string;
  eventName: string;
  wallet: WalletSummary;
  card: { cardRef: string; status: string } | null;
  team: TeamInfo | null;
  transactions: LedgerRow[];
  lowBalanceThreshold: number;
  transfersEnabled: boolean;
}): React.ReactElement {

  return (
    <div className="min-h-screen bg-ink-100 pb-16">
      <header className="bg-ink-900 px-4 pb-16 pt-8 text-white">
        <div className="mx-auto flex max-w-lg items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm text-ink-400">{eventName}</p>
            <h1 className="mt-1 truncate text-xl font-bold">{displayName}</h1>
            <p className="tabular text-xs text-ink-400">{participantRef}</p>
          </div>
          {/* Staff sign in here too, and a shared phone must not stay signed in. */}
          <SignOutButton />
        </div>
      </header>

      <main className="mx-auto -mt-12 max-w-lg space-y-4 px-4">
        <Card className="text-center">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">Balance</p>
          <p className="mt-1">
            <Points value={wallet.balance} size="xl" />
          </p>
          <p className="mt-1 text-sm text-ink-500">points</p>

          {wallet.balance < lowBalanceThreshold ? (
            <div className="mt-4">
              <Alert tone="warn" title="Low balance">
                Visit a top-up counter to add more points.
              </Alert>
            </div>
          ) : null}

          <div className="mt-5 grid grid-cols-2 gap-3 text-left">
            <div className="rounded-xl bg-ink-50 p-3">
              <p className="text-xs text-ink-500">Earned</p>
              <Points value={wallet.lifetimeEarned} />
            </div>
            <div className="rounded-xl bg-ink-50 p-3">
              <p className="text-xs text-ink-500">Spent</p>
              <Points value={wallet.lifetimeSpent} />
            </div>
          </div>

        </Card>

        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <h2 className="text-sm font-bold uppercase tracking-wide text-ink-500">My card</h2>
            {card ? (
              <div className="mt-2">
                <p className="tabular text-lg font-semibold text-ink-900">{card.cardRef}</p>
                <p className="mt-1">
                  <Badge tone="success">Active</Badge>
                </p>
              </div>
            ) : (
              <p className="mt-2 text-sm text-ink-500">
                No card linked yet. Staff can link one for you — your points are safe either way,
                they live in your account, not on the card.
              </p>
            )}
          </Card>

          {team ? (
            <Card>
              <h2 className="text-sm font-bold uppercase tracking-wide text-ink-500">My team</h2>
              <div className="mt-2 flex items-center gap-3">
                <span
                  aria-hidden
                  className="h-8 w-8 rounded-full"
                  style={{ backgroundColor: team.color }}
                />
                <div>
                  <p className="font-semibold text-ink-900">{team.name}</p>
                  {team.rank ? (
                    <p className="text-sm text-ink-500">
                      Rank #{team.rank} of {team.totalTeams} · {team.score.toLocaleString()} pts
                    </p>
                  ) : null}
                </div>
              </div>
            </Card>
          ) : null}
        </div>

        {transfersEnabled ? (
          <Card>
            <p className="text-sm text-ink-600">
              Sending points to other participants is enabled for this event. Ask staff if you
              need help.
            </p>
          </Card>
        ) : null}

        <Card>
          <h2 className="text-sm font-bold uppercase tracking-wide text-ink-500">
            Recent activity
          </h2>
          {transactions.length === 0 ? (
            <p className="mt-4 text-sm text-ink-500">Nothing yet.</p>
          ) : (
            <ul className="mt-2 divide-y divide-ink-200">
              {transactions.map((entry) => (
                <li key={entry.entryId} className="flex items-start justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-ink-900">
                      {TYPE_LABELS[entry.type] ?? entry.type}
                    </p>
                    <p className="truncate text-xs text-ink-500">{entry.reason}</p>
                    <p className="tabular text-xs text-ink-400">
                      {new Date(entry.createdAt).toLocaleString()} · {entry.txnRef}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <Points value={entry.amount} signed />
                    <p className="tabular text-xs text-ink-400">
                      {entry.balanceAfter.toLocaleString()}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </main>
    </div>
  );
}
