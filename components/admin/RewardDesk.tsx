'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, api, newIdempotencyKey } from '@/lib/client/api';
import { Alert, Badge, Button, Card, EmptyState, Points } from '@/components/ui/primitives';

export interface RewardRow {
  id: string;
  name: string;
  description: string | null;
  costPoints: number;
  stock: number | null;
  isActive: boolean;
  redeemed: number;
}

export interface ClaimRow {
  id: string;
  rewardName: string;
  participantName: string;
  costPoints: number;
  status: 'CLAIMED' | 'FULFILLED' | 'CANCELLED';
  createdAt: string;
}

export interface PersonOption {
  id: string;
  displayName: string;
}

/**
 * The rewards desk.
 *
 * Redemption is staff-initiated rather than self-service on the participant's
 * phone, because that matches how a desk actually runs: somebody walks up,
 * staff takes the points and hands the thing over in the same moment. A
 * self-service claim that is never collected is a support conversation.
 */
export function RewardDesk({
  rewards,
  claims,
  people,
  canWrite,
  canFulfil,
  canRedeemForOthers,
}: {
  rewards: RewardRow[];
  claims: ClaimRow[];
  people: PersonOption[];
  canWrite: boolean;
  canFulfil: boolean;
  canRedeemForOthers: boolean;
}): React.ReactElement {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [redeemingFor, setRedeemingFor] = useState<string | null>(null);
  const [person, setPerson] = useState('');
  const [form, setForm] = useState({ name: '', costPoints: '200', stock: '' });

  async function run(key: string, work: () => Promise<string>): Promise<void> {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      setNotice(await work());
      router.refresh();
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(null);
    }
  }

  async function create(): Promise<void> {
    if (form.name.trim().length < 2) {
      setError('Give the reward a name.');
      return;
    }
    await run('create', async () => {
      await api('/api/rewards', {
        method: 'POST',
        body: {
          name: form.name.trim(),
          costPoints: Number(form.costPoints || 0),
          // Blank means unlimited, which is a real answer rather than zero.
          stock: form.stock.trim() === '' ? null : Number(form.stock),
        },
      });
      setForm({ name: '', costPoints: '200', stock: '' });
      setCreating(false);
      return `“${form.name.trim()}” added.`;
    });
  }

  async function setActive(reward: RewardRow, isActive: boolean): Promise<void> {
    await run(`active-${reward.id}`, async () => {
      await api(`/api/rewards/${reward.id}`, { method: 'PATCH', body: { isActive } });
      return `“${reward.name}” ${isActive ? 'is back on the list' : 'retired'}.`;
    });
  }

  async function redeem(reward: RewardRow): Promise<void> {
    if (!person) {
      setError('Pick a participant first.');
      return;
    }
    const name = people.find((candidate) => candidate.id === person)?.displayName ?? 'them';
    await run(`redeem-${reward.id}`, async () => {
      await api(`/api/rewards/${reward.id}/redeem`, {
        method: 'POST',
        body: { userId: person },
        idempotencyKey: newIdempotencyKey(),
      });
      setRedeemingFor(null);
      return `“${reward.name}” redeemed for ${name}.`;
    });
  }

  async function fulfil(claim: ClaimRow): Promise<void> {
    await run(`fulfil-${claim.id}`, async () => {
      await api(`/api/redemptions/${claim.id}/fulfil`, { method: 'POST' });
      return `Handed “${claim.rewardName}” to ${claim.participantName}.`;
    });
  }

  async function cancel(claim: ClaimRow): Promise<void> {
    const reason = window.prompt(`Why is this claim being cancelled?`)?.trim();
    if (!reason || reason.length < 3) {
      setError('A cancellation needs a reason of at least 3 characters.');
      return;
    }
    await run(`cancel-${claim.id}`, async () => {
      await api(`/api/redemptions/${claim.id}/cancel`, {
        method: 'POST',
        body: { reason },
        idempotencyKey: newIdempotencyKey(),
      });
      return `Cancelled, and ${claim.costPoints.toLocaleString()} points returned.`;
    });
  }

  const open = claims.filter((claim) => claim.status === 'CLAIMED');

  return (
    <div className="space-y-6">
      {error ? (
        <Alert tone="danger" title="That did not work">
          {error}
        </Alert>
      ) : null}
      {notice ? (
        <Alert tone="success" title="Done">
          {notice}
        </Alert>
      ) : null}

      <section>
        <div className="mb-2 flex items-center justify-between gap-3">
          <h2 className="text-sm font-bold uppercase tracking-wide text-ink-500">
            Waiting to collect
          </h2>
          <span className="text-sm text-ink-500">{open.length}</span>
        </div>

        {open.length === 0 ? (
          <EmptyState title="Nothing waiting" description="Claims appear here until handed over." />
        ) : (
          <Card padded={false}>
            <ul className="divide-y divide-ink-100">
              {open.map((claim) => (
                <li key={claim.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold text-ink-900">
                      {claim.rewardName}
                    </span>
                    <span className="block text-xs text-ink-500">{claim.participantName}</span>
                  </span>
                  <Points value={claim.costPoints} size="sm" />
                  {canFulfil ? (
                    <>
                      <Button
                        size="sm"
                        onClick={() => void fulfil(claim)}
                        disabled={busy === `fulfil-${claim.id}`}
                      >
                        Hand over
                      </Button>
                      <Button
                        size="sm"
                        tone="neutral"
                        onClick={() => void cancel(claim)}
                        disabled={busy === `cancel-${claim.id}`}
                      >
                        Cancel
                      </Button>
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between gap-3">
          <h2 className="text-sm font-bold uppercase tracking-wide text-ink-500">Rewards</h2>
          {canWrite ? (
            <Button size="sm" tone="neutral" onClick={() => setCreating((open_) => !open_)}>
              {creating ? 'Cancel' : 'New reward'}
            </Button>
          ) : null}
        </div>

        {creating ? (
          <Card className="mb-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="text-sm">
                <span className="mb-1 block font-medium text-ink-700">Name</span>
                <input
                  value={form.name}
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                  placeholder="Queue skip"
                  className="w-full rounded-lg border border-ink-300 px-3 py-2"
                />
              </label>
              <label className="text-sm">
                <span className="mb-1 block font-medium text-ink-700">Cost in points</span>
                <input
                  value={form.costPoints}
                  onChange={(event) => setForm({ ...form, costPoints: event.target.value })}
                  inputMode="numeric"
                  className="w-full rounded-lg border border-ink-300 px-3 py-2"
                />
              </label>
              <label className="text-sm">
                <span className="mb-1 block font-medium text-ink-700">
                  Stock <span className="text-ink-400">(blank = unlimited)</span>
                </span>
                <input
                  value={form.stock}
                  onChange={(event) => setForm({ ...form, stock: event.target.value })}
                  inputMode="numeric"
                  placeholder="∞"
                  className="w-full rounded-lg border border-ink-300 px-3 py-2"
                />
              </label>
            </div>
            <div className="mt-3">
              <Button onClick={() => void create()} disabled={busy === 'create'}>
                {busy === 'create' ? 'Adding…' : 'Add reward'}
              </Button>
            </div>
          </Card>
        ) : null}

        {rewards.length === 0 ? (
          <EmptyState
            title="No rewards"
            description="Add one to let participants spend points on something other than stock."
          />
        ) : (
          <div className="space-y-2">
            {rewards.map((reward) => (
              <Card key={reward.id}>
                <div className="flex flex-wrap items-center gap-3">
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate font-semibold text-ink-900">{reward.name}</span>
                      {reward.isActive ? null : <Badge tone="neutral">retired</Badge>}
                      {reward.stock === 0 ? <Badge tone="danger">out of stock</Badge> : null}
                    </span>
                    <span className="block text-xs text-ink-500">
                      {reward.stock === null ? 'Unlimited' : `${reward.stock} left`} ·{' '}
                      {reward.redeemed} redeemed
                    </span>
                  </span>

                  <Points value={reward.costPoints} />

                  {canRedeemForOthers && reward.isActive && reward.stock !== 0 ? (
                    <Button
                      size="sm"
                      onClick={() =>
                        setRedeemingFor(redeemingFor === reward.id ? null : reward.id)
                      }
                    >
                      Redeem
                    </Button>
                  ) : null}
                  {canWrite ? (
                    <Button
                      size="sm"
                      tone="neutral"
                      onClick={() => void setActive(reward, !reward.isActive)}
                      disabled={busy === `active-${reward.id}`}
                    >
                      {reward.isActive ? 'Retire' : 'Restore'}
                    </Button>
                  ) : null}
                </div>

                {redeemingFor === reward.id ? (
                  <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-ink-100 pt-3">
                    <select
                      value={person}
                      onChange={(event) => setPerson(event.target.value)}
                      className="min-w-0 flex-1 rounded-lg border border-ink-300 px-3 py-2 text-sm"
                    >
                      <option value="">Pick a participant…</option>
                      {people.map((candidate) => (
                        <option key={candidate.id} value={candidate.id}>
                          {candidate.displayName}
                        </option>
                      ))}
                    </select>
                    <Button
                      onClick={() => void redeem(reward)}
                      disabled={busy === `redeem-${reward.id}` || !person}
                    >
                      {busy === `redeem-${reward.id}` ? 'Redeeming…' : 'Take points'}
                    </Button>
                  </div>
                ) : null}
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
