'use client';

import { useCallback, useState } from 'react';
import { ApiError, api } from '@/lib/client/api';
import type { UserUsage } from '@/lib/services/tenancy';
import { Alert, Badge, Button, Card } from '@/components/ui/primitives';

interface Activity {
  action: string;
  actor: string | null;
  targetType: string | null;
  ipAddress: string | null;
  createdAt: string;
}

const WIPE_PHRASE = 'DELETE EVERYTHING';

function when(value: string | null): string {
  if (!value) return 'never';
  return new Date(value).toLocaleString();
}

export function SystemConsole({
  usage,
  activity,
}: {
  usage: UserUsage[];
  activity: Activity[];
}): React.ReactElement {
  return (
    <div className="space-y-8">
      <Credentials />
      <Usage rows={usage} />
      <Activity rows={activity} />
      <DangerZone />
    </div>
  );
}

function Credentials(): React.ReactElement {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      await api('/api/account/credentials', {
        method: 'POST',
        body: {
          currentPassword,
          newEmail: newEmail.trim() || null,
          newPassword: newPassword || null,
        },
      });
      setDone(true);
      setCurrentPassword('');
      setNewEmail('');
      setNewPassword('');
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : 'Could not change your sign-in details.');
    } finally {
      setBusy(false);
    }
  }, [currentPassword, newEmail, newPassword]);

  return (
    <section>
      <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-ink-500">
        My sign-in details
      </h2>
      <Card className="max-w-md space-y-3">
        {error ? (
          <Alert tone="danger" title="Not changed">
            {error}
          </Alert>
        ) : null}
        {done ? (
          <Alert tone="success" title="Changed">
            Your other sessions were signed out.
          </Alert>
        ) : null}

        <div>
          <label htmlFor="current" className="block text-sm font-medium text-ink-700">
            Current password
          </label>
          <input
            id="current"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            className="mt-1 w-full rounded-xl border border-ink-300 px-4 py-2.5"
          />
        </div>
        <div>
          <label htmlFor="newEmail" className="block text-sm font-medium text-ink-700">
            New email <span className="text-ink-400">(optional)</span>
          </label>
          <input
            id="newEmail"
            type="email"
            autoComplete="username"
            value={newEmail}
            onChange={(event) => setNewEmail(event.target.value)}
            className="mt-1 w-full rounded-xl border border-ink-300 px-4 py-2.5"
          />
        </div>
        <div>
          <label htmlFor="newPassword" className="block text-sm font-medium text-ink-700">
            New password <span className="text-ink-400">(optional, 12+ characters)</span>
          </label>
          <input
            id="newPassword"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            className="mt-1 w-full rounded-xl border border-ink-300 px-4 py-2.5"
          />
        </div>

        <Button
          disabled={busy || !currentPassword || (!newEmail.trim() && !newPassword)}
          onClick={() => void submit()}
        >
          {busy ? 'Saving' : 'Save'}
        </Button>
      </Card>
    </section>
  );
}

function Usage({ rows }: { rows: UserUsage[] }): React.ReactElement {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<Record<string, UserUsage['status']>>({});

  const change = useCallback(async (userId: string, status: UserUsage['status']) => {
    setPending(userId);
    setError(null);
    try {
      await api('/api/admin/accounts/status', { method: 'POST', body: { userId, status } });
      setStatuses((current) => ({ ...current, [userId]: status }));
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : 'Could not change that account.');
    } finally {
      setPending(null);
    }
  }, []);

  return (
    <section>
      <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-ink-500">Who is using this</h2>
      {error ? (
        <div className="mb-2">
          <Alert tone="danger" title="Not changed">
            {error}
          </Alert>
        </div>
      ) : null}
      <Card padded={false}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[46rem] text-sm">
            <thead className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
              <tr>
                <th className="px-4 py-2">Person</th>
                <th className="px-4 py-2">Roles</th>
                <th className="px-4 py-2">Last sign-in</th>
                <th className="px-4 py-2">Live</th>
                <th className="px-4 py-2">From</th>
                <th className="px-4 py-2">Actions</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {rows.map((person) => {
                const status = statuses[person.userId] ?? person.status;
                return (
                  <tr key={person.userId}>
                    <td className="px-4 py-2">
                      <span className="block font-semibold text-ink-900">{person.displayName}</span>
                      <span className="block text-xs text-ink-500">{person.email ?? 'no email'}</span>
                    </td>
                    <td className="px-4 py-2 text-xs text-ink-600">
                      {person.roles.join(', ') || '—'}
                    </td>
                    <td className="px-4 py-2 text-xs text-ink-600">{when(person.lastLoginAt)}</td>
                    <td className="px-4 py-2">
                      {person.liveSessions > 0 ? (
                        <Badge tone="success">{person.liveSessions}</Badge>
                      ) : (
                        <span className="text-xs text-ink-400">—</span>
                      )}
                    </td>
                    <td className="tabular px-4 py-2 text-xs text-ink-600">
                      {person.lastIp ?? '—'}
                    </td>
                    <td className="tabular px-4 py-2 text-xs text-ink-600">{person.actions}</td>
                    <td className="px-4 py-2 text-right">
                      {person.isSuperAdmin ? (
                        <Badge tone="brand">super admin</Badge>
                      ) : status === 'ACTIVE' ? (
                        <Button
                          size="sm"
                          tone="danger"
                          disabled={pending === person.userId}
                          onClick={() => void change(person.userId, 'SUSPENDED')}
                        >
                          Suspend
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          tone="neutral"
                          disabled={pending === person.userId}
                          onClick={() => void change(person.userId, 'ACTIVE')}
                        >
                          Restore
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </section>
  );
}

function Activity({ rows }: { rows: Activity[] }): React.ReactElement {
  return (
    <section>
      <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-ink-500">
        Latest activity
      </h2>
      <Card padded={false}>
        <ul className="divide-y divide-ink-100">
          {rows.length === 0 ? (
            <li className="px-4 py-3 text-sm text-ink-500">Nothing recorded yet.</li>
          ) : (
            rows.map((entry, index) => (
              <li key={index} className="flex items-baseline gap-3 px-4 py-2 text-sm">
                <span className="tabular shrink-0 text-xs text-ink-500">{when(entry.createdAt)}</span>
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium text-ink-800">{entry.actor ?? 'system'}</span>{' '}
                  <span className="text-ink-600">{entry.action}</span>
                </span>
                <span className="tabular shrink-0 text-xs text-ink-400">{entry.ipAddress ?? ''}</span>
              </li>
            ))
          )}
        </ul>
      </Card>
    </section>
  );
}

function DangerZone(): React.ReactElement {
  const [phrase, setPhrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<{ tablesCleared: number; usersDeleted: number } | null>(null);

  const wipe = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ tablesCleared: number; usersDeleted: number }>('/api/admin/wipe', {
        method: 'POST',
        body: { confirm: WIPE_PHRASE },
      });
      setSummary(result);
      setPhrase('');
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : 'The reset did not run.');
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <section>
      <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-danger-700">
        Reset for a new client
      </h2>
      <Card className="max-w-md space-y-3 border-danger-300">
        {error ? (
          <Alert tone="danger" title="Not reset">
            {error}
          </Alert>
        ) : null}
        {summary ? (
          <Alert tone="success" title="Reset done">
            {summary.tablesCleared} tables cleared and {summary.usersDeleted} account(s) deleted.
            Create a new event to start.
          </Alert>
        ) : null}

        <p className="text-sm text-ink-600">
          Deletes every event, wallet, card, product and purchase, and every account except super
          admins. There is no undo.
        </p>

        <div>
          <label htmlFor="phrase" className="block text-sm font-medium text-ink-700">
            Type <span className="font-bold">{WIPE_PHRASE}</span> to confirm
          </label>
          <input
            id="phrase"
            value={phrase}
            onChange={(event) => setPhrase(event.target.value)}
            autoComplete="off"
            className="mt-1 w-full rounded-xl border border-ink-300 px-4 py-2.5"
          />
        </div>

        <Button tone="danger" disabled={busy || phrase !== WIPE_PHRASE} onClick={() => void wipe()}>
          {busy ? 'Resetting' : 'Reset the system'}
        </Button>
      </Card>
    </section>
  );
}
