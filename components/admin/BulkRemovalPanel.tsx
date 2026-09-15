'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, api, newIdempotencyKey } from '@/lib/client/api';
import { Alert, Badge, Button, Card, Spinner } from '@/components/ui/primitives';

type Verdict = 'DELETE' | 'DEACTIVATE' | 'BLOCKED';

interface ServerRow {
  verdict: Verdict;
  reason: string;
  cardRef?: string;
  holder?: string | null;
  displayName?: string;
  participantRef?: string;
  forfeitSpendable?: number;
  forfeitScore?: number;
}

interface Plan {
  rows: ServerRow[];
  deleteCount: number;
  deactivateCount: number;
  blockedCount: number;
  pointsForfeited: number;
}

const ENDPOINTS = {
  cards: '/api/admin/cards/removal',
  participants: '/api/admin/participants/removal',
} as const;

const VERDICT_TONE: Record<Verdict, 'danger' | 'warn' | 'neutral'> = {
  DELETE: 'danger',
  DEACTIVATE: 'warn',
  BLOCKED: 'neutral',
};

const VERDICT_LABEL: Record<Verdict, string> = {
  DELETE: 'Delete',
  DEACTIVATE: 'Deactivate',
  BLOCKED: 'Skip',
};

/**
 * The confirmation step for a bulk removal.
 *
 * The operator never confirms a count alone — they confirm the plan the server
 * produced, row by row, because "delete 48" and "delete 41, deactivate 7, write
 * off 2,340 points" are different decisions and only the second one is true.
 */
export function BulkRemovalPanel({
  kind,
  ids,
  onCleared,
}: {
  kind: 'cards' | 'participants';
  ids: string[];
  onCleared: () => void;
}): React.ReactElement | null {
  const router = useRouter();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [reason, setReason] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const noun = kind === 'cards' ? 'card' : 'participant';

  const close = useCallback(() => {
    setPlan(null);
    setReason('');
    setAcknowledged(false);
    setError(null);
  }, []);

  const preview = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setPlan(await api<Plan>(`${ENDPOINTS[kind]}/preview`, { method: 'POST', body: { ids } }));
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : 'Could not read the selection.');
    } finally {
      setBusy(false);
    }
  }, [ids, kind]);

  const commit = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<Plan>(ENDPOINTS[kind], {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
        body: { ids, reason: reason.trim() },
      });
      close();
      onCleared();
      router.refresh();
      // Surfaced as a banner on the refreshed list rather than a modal the
      // operator has to dismiss before they can see the result.
      setNotice(
        `Removed ${result.deleteCount + result.deactivateCount} ${noun}s — ` +
          `${result.deleteCount} deleted, ${result.deactivateCount} deactivated` +
          (result.pointsForfeited > 0
            ? `, ${result.pointsForfeited.toLocaleString()} points forfeited.`
            : '.'),
      );
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : 'The removal did not complete.');
    } finally {
      setBusy(false);
    }
  }, [close, ids, kind, noun, onCleared, reason, router]);

  if (ids.length === 0 && plan === null) {
    return notice ? <Alert tone="success" title={notice} /> : null;
  }

  if (plan === null) {
    return (
      <div className="sticky bottom-0 z-10 -mx-1 px-1 pb-1">
        <Card className="flex flex-wrap items-center justify-between gap-3 border-brand-500 shadow-lg">
          <p className="text-sm font-medium text-ink-800">
            {ids.length} {noun}
            {ids.length === 1 ? '' : 's'} selected
          </p>
          <div className="flex gap-2">
            <Button size="sm" tone="neutral" onClick={onCleared}>
              Clear
            </Button>
            <Button size="sm" tone="danger" disabled={busy} onClick={() => void preview()}>
              {busy ? 'Checking…' : 'Remove…'}
            </Button>
          </div>
        </Card>
        {error ? (
          <Alert tone="danger" title="Not removed">
            {error}
          </Alert>
        ) : null}
      </div>
    );
  }

  const actionable = plan.deleteCount + plan.deactivateCount;

  return (
    <Card className="space-y-4 border-danger-500">
      <div>
        <h2 className="text-lg font-bold text-ink-900">Confirm removal</h2>
        <p className="mt-1 text-sm text-ink-500">
          The database decides which rows can be deleted. Anything with history is deactivated
          instead so the ledger and the tap trail stay intact.
        </p>
      </div>

      <div className="flex flex-wrap gap-2 text-sm">
        <Badge tone="danger">{plan.deleteCount} deleted</Badge>
        <Badge tone="warn">{plan.deactivateCount} deactivated</Badge>
        {plan.blockedCount > 0 ? <Badge tone="neutral">{plan.blockedCount} skipped</Badge> : null}
        {plan.pointsForfeited > 0 ? (
          <Badge tone="danger">{plan.pointsForfeited.toLocaleString()} points forfeited</Badge>
        ) : null}
      </div>

      <div className="max-h-64 overflow-y-auto rounded-xl border border-ink-200">
        <table className="w-full text-sm">
          <tbody className="divide-y divide-ink-200">
            {plan.rows.map((row, index) => (
              <tr key={`${row.cardRef ?? row.participantRef ?? index}`}>
                <td className="px-3 py-2">
                  <p className="font-medium text-ink-900">
                    {kind === 'cards' ? row.cardRef : row.displayName}
                  </p>
                  <p className="tabular text-xs text-ink-400">
                    {kind === 'cards' ? (row.holder ?? 'unassigned') : row.participantRef}
                  </p>
                </td>
                <td className="px-3 py-2 text-xs text-ink-500">{row.reason}</td>
                <td className="px-3 py-2 text-right">
                  <Badge tone={VERDICT_TONE[row.verdict]}>{VERDICT_LABEL[row.verdict]}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {actionable === 0 ? (
        <Alert tone="warn" title="Nothing to remove">
          Every selected row was skipped. Check the reasons above.
        </Alert>
      ) : (
        <>
          <div>
            <label htmlFor="removal-reason" className="block text-sm font-medium text-ink-700">
              Reason
            </label>
            <input
              id="removal-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Duplicate import from the 9am roster"
              className="mt-1 w-full rounded-xl border border-ink-300 px-4 py-2.5 text-sm"
            />
            <p className="mt-1 text-xs text-ink-400">
              Written to the audit log as the only record of why these rows went.
            </p>
          </div>

          {plan.pointsForfeited > 0 ? (
            <label className="flex items-start gap-2 text-sm text-ink-700">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
                className="mt-1"
              />
              <span>
                I understand {plan.pointsForfeited.toLocaleString()} points will be written off to
                the event&apos;s forfeiture account and cannot be spent afterwards.
              </span>
            </label>
          ) : null}
        </>
      )}

      {error ? (
        <Alert tone="danger" title="Not removed">
          {error}
        </Alert>
      ) : null}

      {busy ? (
        <div className="flex justify-center py-4">
          <Spinner label="Removing" />
        </div>
      ) : (
        <div className="flex justify-end gap-2">
          <Button tone="neutral" onClick={close}>
            Cancel
          </Button>
          <Button
            tone="danger"
            disabled={
              actionable === 0 ||
              reason.trim().length < 5 ||
              (plan.pointsForfeited > 0 && !acknowledged)
            }
            onClick={() => void commit()}
          >
            Remove {actionable} {noun}
            {actionable === 1 ? '' : 's'}
          </Button>
        </div>
      )}
    </Card>
  );
}
