'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, api } from '@/lib/client/api';
import type { UserUsage } from '@/lib/services/tenancy';
import { Alert, Badge, Button, Card } from '@/components/ui/primitives';

export function StaffAccounts({
  accounts,
  roleKeys,
}: {
  accounts: UserUsage[];
  roleKeys: string[];
}): React.ReactElement {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const run = useCallback(
    async (work: () => Promise<void>, success: string) => {
      setError(null);
      setNotice(null);
      try {
        await work();
        setNotice(success);
        setAdding(false);
        router.refresh();
      } catch (failure) {
        setError(failure instanceof ApiError ? failure.message : 'That did not work.');
      }
    },
    [router],
  );

  return (
    <section className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-ink-900">Staff logins</h2>
          <p className="text-sm text-ink-500">
            Accounts that run the event. A staff login has no wallet and no card — somebody who
            needs both is enrolled at the desk as well.
          </p>
        </div>
        <Button size="sm" onClick={() => setAdding((open) => !open)}>
          {adding ? 'Cancel' : 'Add login'}
        </Button>
      </header>

      {error ? (
        <Alert tone="danger" title="Not saved">
          {error}
        </Alert>
      ) : null}
      {notice ? <Alert tone="success" title={notice} /> : null}

      {adding ? <AddStaffForm roleKeys={roleKeys} run={run} /> : null}

      <Card padded={false}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
              <tr>
                <th className="px-4 py-2">Account</th>
                <th className="px-4 py-2">Role</th>
                <th className="hidden px-4 py-2 sm:table-cell">Last signed in</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-200">
              {accounts.map((account) => (
                <tr key={account.userId}>
                  <td className="px-4 py-3">
                    <p className="font-medium text-ink-900">{account.displayName}</p>
                    <p className="text-xs text-ink-400">{account.email ?? 'no email'}</p>
                  </td>
                  <td className="px-4 py-3">
                    {account.isSuperAdmin ? (
                      <Badge tone="warn">Super admin</Badge>
                    ) : account.roles.length > 0 ? (
                      <span className="flex flex-wrap gap-1">
                        {account.roles.map((role) => (
                          <Badge key={role} tone="neutral">
                            {role}
                          </Badge>
                        ))}
                      </span>
                    ) : (
                      <span className="text-ink-400">—</span>
                    )}
                  </td>
                  <td className="hidden px-4 py-3 text-xs text-ink-500 sm:table-cell">
                    {account.lastLoginAt
                      ? new Date(account.lastLoginAt).toLocaleString()
                      : 'never'}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap justify-end gap-1">
                      {account.isSuperAdmin ? (
                        <span className="text-xs text-ink-400">Owner</span>
                      ) : (
                        <>
                          <select
                            value=""
                            aria-label={`Change role for ${account.displayName}`}
                            onChange={(event) => {
                              const roleKey = event.target.value;
                              if (!roleKey) return;
                              void run(
                                () =>
                                  api('/api/admin/accounts', {
                                    method: 'PATCH',
                                    body: { userId: account.userId, roleKey },
                                  }),
                                `${account.displayName} is now ${roleKey}. They will be signed out.`,
                              );
                            }}
                            className="rounded-lg border border-ink-300 px-2 py-1 text-xs"
                          >
                            <option value="">Change role…</option>
                            {roleKeys.map((role) => (
                              <option key={role} value={role}>
                                {role}
                              </option>
                            ))}
                          </select>
                          <Button
                            size="sm"
                            tone="danger"
                            onClick={() => {
                              if (!window.confirm(`Delete the login for ${account.displayName}?`)) {
                                return;
                              }
                              void run(
                                () =>
                                  api(`/api/admin/accounts/${account.userId}`, {
                                    method: 'DELETE',
                                  }),
                                `${account.displayName}'s login is gone.`,
                              );
                            }}
                          >
                            Delete
                          </Button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </section>
  );
}

function AddStaffForm({
  roleKeys,
  run,
}: {
  roleKeys: string[];
  run: (work: () => Promise<void>, success: string) => Promise<void>;
}): React.ReactElement {
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [roleKey, setRoleKey] = useState(roleKeys[0] ?? '');

  const ready =
    displayName.trim().length >= 2 && email.includes('@') && password.length >= 12 && roleKey;

  return (
    <Card className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm font-medium text-ink-700">
          Name
          <input
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            aria-label="Staff name"
            className="mt-1 w-full rounded-xl border border-ink-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="text-sm font-medium text-ink-700">
          Email
          <input
            type="email"
            autoComplete="off"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            aria-label="Staff email"
            className="mt-1 w-full rounded-xl border border-ink-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="text-sm font-medium text-ink-700">
          Password
          <input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-label="Staff password"
            className="mt-1 w-full rounded-xl border border-ink-300 px-3 py-2 text-sm"
          />
          <span className="mt-1 block text-xs text-ink-400">
            At least 12 characters. Shown to nobody afterwards — hand it over now.
          </span>
        </label>
        <label className="text-sm font-medium text-ink-700">
          Role
          <select
            value={roleKey}
            onChange={(event) => setRoleKey(event.target.value)}
            aria-label="Staff role"
            className="mt-1 w-full rounded-xl border border-ink-300 px-3 py-2 text-sm"
          >
            {roleKeys.map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex justify-end">
        <Button
          disabled={!ready}
          onClick={() =>
            void run(
              () =>
                api('/api/admin/accounts', {
                  method: 'POST',
                  body: {
                    displayName: displayName.trim(),
                    email: email.trim(),
                    password,
                    roleKey,
                  },
                }),
              `${displayName.trim()} can now sign in.`,
            )
          }
        >
          Create login
        </Button>
      </div>
    </Card>
  );
}
