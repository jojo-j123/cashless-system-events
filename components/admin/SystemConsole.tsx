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
  const [openLogin, setOpenLogin] = useState<string | null>(null);

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
      <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-ink-500">
        Who is using this
      </h2>
      {error ? (
        <div className="mb-2">
          <Alert tone="danger" title="Not changed">
            {error}
          </Alert>
        </div>
      ) : null}

      {/* A list rather than a table: the same rows have to be readable on the
          phone at the registration desk, and a seven-column table there is a
          horizontal scrollbar with the important part off-screen. */}
      <div className="space-y-2">
        {rows.map((person) => {
          const status = statuses[person.userId] ?? person.status;
          const isOpen = openLogin === person.userId;

          return (
            <Card key={person.userId} className="space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold text-ink-900">
                    {person.displayName}{' '}
                    {person.isSuperAdmin ? <Badge tone="brand">super admin</Badge> : null}
                    {status !== 'ACTIVE' ? <Badge tone="danger">{status.toLowerCase()}</Badge> : null}
                  </p>
                  <p className="truncate text-sm text-ink-500">{person.email ?? 'no email'}</p>
                  <p className="mt-1 text-xs text-ink-500">{person.roles.join(', ') || 'no roles'}</p>
                </div>
                {person.liveSessions > 0 ? (
                  <Badge tone="success">{person.liveSessions} signed in</Badge>
                ) : null}
              </div>

              <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                <div>
                  <dt className="text-ink-500">Last sign-in</dt>
                  <dd className="text-ink-800">{when(person.lastLoginAt)}</dd>
                </div>
                <div>
                  <dt className="text-ink-500">From</dt>
                  <dd className="tabular text-ink-800">{person.lastIp ?? '—'}</dd>
                </div>
                <div>
                  <dt className="text-ink-500">Actions</dt>
                  <dd className="tabular text-ink-800">{person.actions}</dd>
                </div>
                <div>
                  <dt className="text-ink-500">Last action</dt>
                  <dd className="text-ink-800">{when(person.lastActionAt)}</dd>
                </div>
              </dl>

              {person.isSuperAdmin ? null : (
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    tone="neutral"
                    onClick={() => setOpenLogin(isOpen ? null : person.userId)}
                  >
                    {isOpen ? 'Cancel' : 'Set login'}
                  </Button>
                  {status === 'ACTIVE' ? (
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
                </div>
              )}

              {isOpen ? (
                <SetLogin person={person} onDone={() => setOpenLogin(null)} />
              ) : null}
            </Card>
          );
        })}
      </div>
    </section>
  );
}

/**
 * Hand someone a login.
 *
 * Nobody can produce a staff member's current password on their behalf, so
 * this is authorised by being the owner rather than by proving who they are.
 * Setting a password ends their sessions, or new details would sit alongside
 * an old login that still worked.
 */
function SetLogin({
  person,
  onDone,
}: {
  person: UserUsage;
  onDone: () => void;
}): React.ReactElement {
  const [email, setEmail] = useState(person.email ?? '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const emailChanged = email.trim().toLowerCase() !== (person.email ?? '').toLowerCase();

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await api('/api/admin/accounts/credentials', {
        method: 'POST',
        body: {
          userId: person.userId,
          newEmail: emailChanged ? email.trim() : null,
          newPassword: password || null,
        },
      });
      setSaved(true);
      setPassword('');
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : 'Could not set those details.');
    } finally {
      setBusy(false);
    }
  }, [email, emailChanged, password, person.userId]);

  return (
    <div className="space-y-3 rounded-xl bg-ink-50 p-3">
      {error ? (
        <Alert tone="danger" title="Not saved">
          {error}
        </Alert>
      ) : null}
      {saved ? (
        <Alert tone="success" title="Saved">
          {password ? 'Their other sessions were signed out.' : 'Email updated.'}
        </Alert>
      ) : null}

      <div>
        <label htmlFor={`email-${person.userId}`} className="block text-sm font-medium text-ink-700">
          Email
        </label>
        <input
          id={`email-${person.userId}`}
          type="email"
          autoComplete="off"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="mt-1 w-full rounded-xl border border-ink-300 px-4 py-2.5"
        />
      </div>
      <div>
        <label
          htmlFor={`password-${person.userId}`}
          className="block text-sm font-medium text-ink-700"
        >
          New password <span className="text-ink-400">(optional, 12+ characters)</span>
        </label>
        <input
          id={`password-${person.userId}`}
          type="text"
          autoComplete="off"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="mt-1 w-full rounded-xl border border-ink-300 px-4 py-2.5"
          // Shown rather than masked: whoever types it here has to read it back
          // to the person it belongs to.
        />
      </div>

      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={busy || (!emailChanged && !password)}
          onClick={() => void submit()}
        >
          {busy ? 'Saving' : 'Save'}
        </Button>
        <Button size="sm" tone="neutral" onClick={onDone}>
          Close
        </Button>
      </div>
    </div>
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
