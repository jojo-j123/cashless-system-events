'use client';

import { useMemo, useState } from 'react';
import { Badge, Card, EmptyState, Points } from '@/components/ui/primitives';
import { BulkRemovalPanel } from '@/components/admin/BulkRemovalPanel';

export interface ParticipantRow {
  userId: string;
  displayName: string;
  email: string | null;
  participantRef: string;
  teamName: string | null;
  teamColor: string | null;
  balance: number;
  lifetimeEarned: number;
  lifetimeSpent: number;
  cardRef: string | null;
}

export function ParticipantManager({
  rows,
  canRemove,
}: {
  rows: ParticipantRow[];
  canRemove: boolean;
}): React.ReactElement {
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(
      (row) =>
        row.displayName.toLowerCase().includes(needle) ||
        row.participantRef.toLowerCase().includes(needle) ||
        (row.email ?? '').toLowerCase().includes(needle) ||
        (row.teamName ?? '').toLowerCase().includes(needle),
    );
  }, [filter, rows]);

  const toggle = (userId: string): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(userId)) next.add(userId);
      return next;
    });
  };

  // Select-all covers what the filter is showing, never the rows hidden behind
  // it — a checkbox must not reach further than the eye can.
  const allVisibleSelected = visible.length > 0 && visible.every((row) => selected.has(row.userId));

  const toggleAllVisible = (): void => {
    setSelected(allVisibleSelected ? new Set() : new Set(visible.map((row) => row.userId)));
  };

  if (rows.length === 0) {
    return <EmptyState title="No participants" description="Nobody has been enrolled yet." />;
  }

  return (
    <div className="space-y-4">
      <Card padded={false}>
        <div className="border-b border-ink-200 p-4">
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Search by name, reference, email or team"
            aria-label="Search participants"
            className="w-full rounded-lg border border-ink-300 px-3 py-2 text-sm"
          />
        </div>

        {visible.length === 0 ? (
          <div className="p-6">
            <EmptyState title="No matches" description="Nothing matches that search." />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
                <tr>
                  {canRemove ? (
                    <th className="px-4 py-2">
                      <input
                        type="checkbox"
                        checked={allVisibleSelected}
                        onChange={toggleAllVisible}
                        aria-label="Select all visible participants"
                      />
                    </th>
                  ) : null}
                  <th className="px-4 py-2">Participant</th>
                  <th className="px-4 py-2">Team</th>
                  <th className="hidden px-4 py-2 sm:table-cell">Card</th>
                  <th className="px-4 py-2 text-right">Balance</th>
                  <th className="hidden px-4 py-2 text-right sm:table-cell">Earned</th>
                  <th className="hidden px-4 py-2 text-right sm:table-cell">Spent</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-200">
                {visible.map((row) => (
                  <tr key={row.userId}>
                    {canRemove ? (
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={selected.has(row.userId)}
                          onChange={() => toggle(row.userId)}
                          aria-label={`Select ${row.displayName}`}
                        />
                      </td>
                    ) : null}
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
        )}
      </Card>

      {canRemove ? (
        <BulkRemovalPanel
          kind="participants"
          ids={[...selected]}
          onCleared={() => setSelected(new Set())}
        />
      ) : null}
    </div>
  );
}
