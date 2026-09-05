'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, api, newIdempotencyKey } from '@/lib/client/api';
import { Alert, Badge, Button, Card, EmptyState, Points } from '@/components/ui/primitives';

export interface ChallengeRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  rewardPoints: number;
  rewardScorePoints: number;
  maxCompletionsPerUser: number;
  status: 'DRAFT' | 'ACTIVE' | 'ENDED';
  completions: number;
}

export interface PlayerOption {
  id: string;
  displayName: string;
}

const STATUS_TONE = {
  DRAFT: 'neutral',
  ACTIVE: 'success',
  ENDED: 'warn',
} as const;

/**
 * Authoring and awarding challenges.
 *
 * Awarding is a money action, so each award carries its own idempotency key —
 * a double-tap on a slow connection returns the original award rather than
 * paying twice. The server enforces that independently; this just stops the
 * obvious case from ever reaching it.
 */
export function ChallengeBoard({
  challenges,
  players,
  canWrite,
  canAward,
}: {
  challenges: ChallengeRow[];
  players: PlayerOption[];
  canWrite: boolean;
  canAward: boolean;
}): React.ReactElement {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [awarding, setAwarding] = useState<string | null>(null);
  const [player, setPlayer] = useState<string>('');
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    name: '',
    rewardPoints: '100',
    rewardScorePoints: '0',
    maxCompletionsPerUser: '1',
  });

  async function run(key: string, work: () => Promise<string>): Promise<void> {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      setNotice(await work());
      router.refresh();
    } catch (failure) {
      setError(
        failure instanceof ApiError ? failure.message : 'Something went wrong. Try again.',
      );
    } finally {
      setBusy(null);
    }
  }

  function slugify(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 100);
  }

  async function create(): Promise<void> {
    const slug = slugify(form.name);
    if (!slug) {
      setError('Give the challenge a name.');
      return;
    }
    await run('create', async () => {
      await api('/api/challenges', {
        method: 'POST',
        body: {
          name: form.name.trim(),
          slug,
          rewardPoints: Number(form.rewardPoints || 0),
          rewardScorePoints: Number(form.rewardScorePoints || 0),
          maxCompletionsPerUser: Number(form.maxCompletionsPerUser || 1),
        },
      });
      setForm({ name: '', rewardPoints: '100', rewardScorePoints: '0', maxCompletionsPerUser: '1' });
      setCreating(false);
      return `“${form.name.trim()}” created as a draft.`;
    });
  }

  async function setStatus(
    challenge: ChallengeRow,
    status: ChallengeRow['status'],
  ): Promise<void> {
    await run(`status-${challenge.id}`, async () => {
      await api(`/api/challenges/${challenge.id}`, { method: 'PATCH', body: { status } });
      return `“${challenge.name}” is now ${status.toLowerCase()}.`;
    });
  }

  async function award(challenge: ChallengeRow): Promise<void> {
    if (!player) {
      setError('Pick a player first.');
      return;
    }
    const name = players.find((candidate) => candidate.id === player)?.displayName ?? 'that player';
    await run(`award-${challenge.id}`, async () => {
      await api(`/api/challenges/${challenge.id}/award`, {
        method: 'POST',
        body: { userId: player },
        idempotencyKey: newIdempotencyKey(),
      });
      setAwarding(null);
      return `“${challenge.name}” awarded to ${name}.`;
    });
  }

  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-sm font-bold uppercase tracking-wide text-ink-500">Challenges</h2>
        {canWrite ? (
          <Button size="sm" tone="neutral" onClick={() => setCreating((open) => !open)}>
            {creating ? 'Cancel' : 'New challenge'}
          </Button>
        ) : null}
      </div>

      {error ? (
        <div className="mb-3">
          <Alert tone="danger" title="That did not work">
            {error}
          </Alert>
        </div>
      ) : null}
      {notice ? (
        <div className="mb-3">
          <Alert tone="success" title="Done">
            {notice}
          </Alert>
        </div>
      ) : null}

      {creating ? (
        <Card className="mb-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              <span className="mb-1 block font-medium text-ink-700">Name</span>
              <input
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder="Find the flag"
                className="w-full rounded-lg border border-ink-300 px-3 py-2"
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium text-ink-700">Spendable points</span>
              <input
                value={form.rewardPoints}
                onChange={(event) => setForm({ ...form, rewardPoints: event.target.value })}
                inputMode="numeric"
                className="w-full rounded-lg border border-ink-300 px-3 py-2"
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium text-ink-700">Score points</span>
              <input
                value={form.rewardScorePoints}
                onChange={(event) => setForm({ ...form, rewardScorePoints: event.target.value })}
                inputMode="numeric"
                className="w-full rounded-lg border border-ink-300 px-3 py-2"
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium text-ink-700">Times each player may earn it</span>
              <input
                value={form.maxCompletionsPerUser}
                onChange={(event) =>
                  setForm({ ...form, maxCompletionsPerUser: event.target.value })
                }
                inputMode="numeric"
                className="w-full rounded-lg border border-ink-300 px-3 py-2"
              />
            </label>
          </div>
          <div className="mt-3">
            <Button onClick={() => void create()} disabled={busy === 'create'}>
              {busy === 'create' ? 'Creating…' : 'Create draft'}
            </Button>
          </div>
        </Card>
      ) : null}

      {challenges.length === 0 ? (
        <EmptyState
          title="No challenges"
          description="Create one to start awarding points for doing things."
        />
      ) : (
        <div className="space-y-2">
          {challenges.map((challenge) => (
            <Card key={challenge.id}>
              <div className="flex flex-wrap items-center gap-3">
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate font-semibold text-ink-900">{challenge.name}</span>
                    <Badge tone={STATUS_TONE[challenge.status]}>
                      {challenge.status.toLowerCase()}
                    </Badge>
                  </span>
                  <span className="block text-xs text-ink-500">
                    {challenge.completions}{' '}
                    {challenge.completions === 1 ? 'completion' : 'completions'}
                    {challenge.maxCompletionsPerUser > 1
                      ? ` · up to ${challenge.maxCompletionsPerUser} each`
                      : ''}
                    {challenge.rewardScorePoints > 0
                      ? ` · ${challenge.rewardScorePoints.toLocaleString()} score`
                      : ''}
                  </span>
                </span>

                <Points value={challenge.rewardPoints} />

                {canWrite && challenge.status === 'DRAFT' ? (
                  <Button
                    size="sm"
                    onClick={() => void setStatus(challenge, 'ACTIVE')}
                    disabled={busy === `status-${challenge.id}`}
                  >
                    Activate
                  </Button>
                ) : null}
                {canWrite && challenge.status === 'ACTIVE' ? (
                  <Button
                    size="sm"
                    tone="neutral"
                    onClick={() => void setStatus(challenge, 'ENDED')}
                    disabled={busy === `status-${challenge.id}`}
                  >
                    End
                  </Button>
                ) : null}
                {canAward && challenge.status === 'ACTIVE' ? (
                  <Button
                    size="sm"
                    tone="brand"
                    onClick={() => setAwarding(awarding === challenge.id ? null : challenge.id)}
                  >
                    Award
                  </Button>
                ) : null}
              </div>

              {awarding === challenge.id ? (
                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-ink-100 pt-3">
                  <select
                    value={player}
                    onChange={(event) => setPlayer(event.target.value)}
                    className="min-w-0 flex-1 rounded-lg border border-ink-300 px-3 py-2 text-sm"
                  >
                    <option value="">Pick a player…</option>
                    {players.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.displayName}
                      </option>
                    ))}
                  </select>
                  <Button
                    onClick={() => void award(challenge)}
                    disabled={busy === `award-${challenge.id}` || !player}
                  >
                    {busy === `award-${challenge.id}` ? 'Awarding…' : 'Confirm'}
                  </Button>
                </div>
              ) : null}
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}
