'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, api, newIdempotencyKey } from '@/lib/client/api';
import { Alert, Badge, Button, Card, EmptyState } from '@/components/ui/primitives';

interface CardRow {
  id: string;
  cardRef: string;
  status: string;
  technology: string;
  batchLabel: string | null;
  lastUsedAt: string | null;
  userId: string | null;
  displayName: string | null;
  participantRef: string | null;
}

interface ParticipantOption {
  userId: string;
  displayName: string;
  participantRef: string;
}

const STATUS_TONE: Record<string, 'success' | 'warn' | 'danger' | 'neutral'> = {
  ACTIVE: 'success',
  UNASSIGNED: 'neutral',
  SUSPENDED: 'warn',
  LOST: 'danger',
  REPLACED: 'neutral',
  DEACTIVATED: 'danger',
};

export function CardManager({
  cards,
  canAssign,
  canSuspend,
  canReplace,
  canCreate,
}: {
  cards: CardRow[];
  canAssign: boolean;
  canSuspend: boolean;
  canReplace: boolean;
  canCreate: boolean;
}): React.ReactElement {
  const router = useRouter();
  const [filter, setFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [issuedTokens, setIssuedTokens] = useState<{ cardRef: string; token: string }[]>([]);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return cards.filter((card) => {
      if (statusFilter !== 'ALL' && card.status !== statusFilter) return false;
      if (!needle) return true;
      return (
        card.cardRef.toLowerCase().includes(needle) ||
        (card.displayName ?? '').toLowerCase().includes(needle) ||
        (card.participantRef ?? '').toLowerCase().includes(needle)
      );
    });
  }, [cards, filter, statusFilter]);

  const run = async (id: string, work: () => Promise<void>, success: string): Promise<void> => {
    setBusyId(id);
    setMessage(null);
    try {
      await work();
      setMessage({ tone: 'success', text: success });
      router.refresh();
    } catch (error) {
      setMessage({
        tone: 'danger',
        text: error instanceof ApiError ? error.message : 'That action could not be completed.',
      });
    } finally {
      setBusyId(null);
    }
  };

  const changeStatus = (card: CardRow, status: string): void => {
    const reason = window.prompt(`Reason for marking ${card.cardRef} as ${status}?`);
    if (!reason || reason.trim().length < 3) return;

    void run(
      card.id,
      () =>
        api(`/api/cards/${card.id}/status`, {
          method: 'POST',
          body: { status, reason: reason.trim() },
        }),
      `${card.cardRef} is now ${status.toLowerCase()}.`,
    );
  };

  const assign = (card: CardRow): void => {
    const participantRef = window.prompt(
      `Link ${card.cardRef} to which participant? Enter their participant reference.`,
    );
    if (!participantRef) return;

    void run(
      card.id,
      async () => {
        const found = await api<{ data: ParticipantOption[] }>(
          `/api/participants?q=${encodeURIComponent(participantRef.trim())}&limit=2`,
        );
        const match = found.data[0];
        if (!match) throw new ApiError(404, 'not_found', 'No participant matched that reference.');
        await api('/api/cards/assign', {
          method: 'POST',
          body: { cardId: card.id, userId: match.userId },
        });
      },
      `${card.cardRef} linked.`,
    );
  };

  const replace = (card: CardRow): void => {
    const newCardRef = window.prompt(
      `Replace ${card.cardRef}. Enter the reference of the new, unassigned card.`,
    );
    if (!newCardRef) return;
    const reason = window.prompt('Reason for the replacement?');
    if (!reason || reason.trim().length < 3) return;

    const replacement = cards.find(
      (entry) => entry.cardRef.toLowerCase() === newCardRef.trim().toLowerCase(),
    );
    if (!replacement) {
      setMessage({ tone: 'danger', text: 'That replacement card is not in this list.' });
      return;
    }

    void run(
      card.id,
      () =>
        api('/api/cards/replace', {
          method: 'POST',
          body: {
            oldCardId: card.id,
            newCardId: replacement.id,
            reason: reason.trim(),
            retireAs: 'LOST',
          },
        }),
      `${card.cardRef} replaced by ${replacement.cardRef}. The wallet was not touched.`,
    );
  };

  const createBatch = (): void => {
    const raw = window.prompt('How many cards should be created?', '50');
    const count = Number(raw);
    if (!Number.isInteger(count) || count < 1) return;

    void run(
      'batch',
      async () => {
        const result = await api<{ cards: { cardRef: string; token: string }[] }>(
          '/api/cards/batch',
          {
            method: 'POST',
            body: { count, batchLabel: `Batch ${new Date().toISOString().slice(0, 10)}` },
            idempotencyKey: newIdempotencyKey(),
          },
        );
        setIssuedTokens(result.cards);
      },
      `${count} cards created.`,
    );
  };

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink-900">NFC cards</h1>
          <p className="text-sm text-ink-500">
            A card is only an identifier. Suspending one never touches the wallet behind it.
          </p>
        </div>
        {canCreate ? <Button onClick={createBatch}>Create batch</Button> : null}
      </header>

      {message ? <Alert tone={message.tone} title={message.text} /> : null}

      {issuedTokens.length > 0 ? (
        <Card>
          <Alert tone="warn" title="Write these tokens to the chips now">
            They are shown once and stored only as hashes. They cannot be recovered.
          </Alert>
          <ul className="tabular mt-3 max-h-60 space-y-1 overflow-y-auto text-xs">
            {issuedTokens.map((entry) => (
              <li key={entry.cardRef} className="flex justify-between gap-4">
                <span className="font-semibold">{entry.cardRef}</span>
                <span className="truncate text-ink-500">{entry.token}</span>
              </li>
            ))}
          </ul>
          <Button
            tone="neutral"
            size="sm"
            className="mt-3"
            onClick={() => setIssuedTokens([])}
          >
            Done — hide tokens
          </Button>
        </Card>
      ) : null}

      <Card padded={false}>
        <div className="flex flex-wrap gap-2 border-b border-ink-200 p-4">
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Search by card, name or reference"
            aria-label="Search cards"
            className="min-w-56 flex-1 rounded-lg border border-ink-300 px-3 py-2 text-sm"
          />
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
            aria-label="Filter by status"
            className="rounded-lg border border-ink-300 px-3 py-2 text-sm"
          >
            {['ALL', 'ACTIVE', 'UNASSIGNED', 'SUSPENDED', 'LOST', 'REPLACED', 'DEACTIVATED'].map(
              (status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ),
            )}
          </select>
        </div>

        {visible.length === 0 ? (
          <div className="p-6">
            <EmptyState title="No cards" description="Nothing matches those filters." />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
                <tr>
                  <th className="px-4 py-2">Card</th>
                  <th className="px-4 py-2">Holder</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="hidden px-4 py-2 sm:table-cell">Last used</th>
                  <th className="px-4 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-200">
                {visible.map((card) => (
                  <tr key={card.id} className={busyId === card.id ? 'opacity-50' : ''}>
                    <td className="px-4 py-3">
                      <p className="tabular font-semibold text-ink-900">{card.cardRef}</p>
                      <p className="text-xs text-ink-400">{card.technology}</p>
                    </td>
                    <td className="px-4 py-3">
                      {card.displayName ? (
                        <>
                          <p className="text-ink-800">{card.displayName}</p>
                          <p className="tabular text-xs text-ink-400">{card.participantRef}</p>
                        </>
                      ) : (
                        <span className="text-ink-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={STATUS_TONE[card.status] ?? 'neutral'}>{card.status}</Badge>
                    </td>
                    <td className="hidden px-4 py-3 text-xs text-ink-500 sm:table-cell">
                      {card.lastUsedAt ? new Date(card.lastUsedAt).toLocaleString() : 'never'}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap justify-end gap-1">
                        {canAssign && card.status === 'UNASSIGNED' ? (
                          <Button size="sm" tone="neutral" onClick={() => assign(card)}>
                            Link
                          </Button>
                        ) : null}
                        {canSuspend && card.status === 'ACTIVE' ? (
                          <>
                            <Button
                              size="sm"
                              tone="warn"
                              onClick={() => changeStatus(card, 'SUSPENDED')}
                            >
                              Suspend
                            </Button>
                            <Button
                              size="sm"
                              tone="danger"
                              onClick={() => changeStatus(card, 'LOST')}
                            >
                              Mark lost
                            </Button>
                          </>
                        ) : null}
                        {canSuspend && card.status === 'SUSPENDED' ? (
                          <Button
                            size="sm"
                            tone="success"
                            onClick={() => changeStatus(card, 'ACTIVE')}
                          >
                            Reactivate
                          </Button>
                        ) : null}
                        {canReplace && card.userId ? (
                          <Button size="sm" tone="neutral" onClick={() => replace(card)}>
                            Replace
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
