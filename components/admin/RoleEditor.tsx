'use client';

import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, api } from '@/lib/client/api';
import { Alert, Badge, Button, Card } from '@/components/ui/primitives';

export interface RoleRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  customised: boolean;
  holders: number;
  permissions: string[];
}

export interface PermissionRow {
  key: string;
  description: string;
  grantable: boolean;
}

/** Group by the prefix, which is already how the catalogue is organised. */
function areaOf(key: string): string {
  const [area] = key.split('.');
  return area ?? key;
}

export function RoleEditor({
  roles,
  permissions,
}: {
  roles: RoleRow[];
  permissions: PermissionRow[];
}): React.ReactElement {
  const router = useRouter();
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const areas = useMemo(() => {
    const grouped = new Map<string, PermissionRow[]>();
    for (const permission of permissions) {
      const area = areaOf(permission.key);
      grouped.set(area, [...(grouped.get(area) ?? []), permission]);
    }
    return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [permissions]);

  const run = useCallback(
    async (work: () => Promise<void>, success: string) => {
      setError(null);
      setNotice(null);
      try {
        await work();
        setNotice(success);
        setEditing(null);
        setCreating(false);
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
          <h2 className="text-lg font-bold text-ink-900">Roles</h2>
          <p className="text-sm text-ink-500">
            What each kind of staff member may do. Permissions that mint points or hand out
            authority are shown but cannot be granted here.
          </p>
        </div>
        <Button size="sm" onClick={() => setCreating((open) => !open)}>
          {creating ? 'Cancel' : 'New role'}
        </Button>
      </header>

      {error ? (
        <Alert tone="danger" title="Not saved">
          {error}
        </Alert>
      ) : null}
      {notice ? <Alert tone="success" title={notice} /> : null}

      {creating ? (
        <RoleForm
          areas={areas}
          onSubmit={(payload) =>
            run(
              () => api('/api/admin/roles', { method: 'POST', body: payload }),
              `${payload.name} created.`,
            )
          }
        />
      ) : null}

      <div className="space-y-3">
        {roles.map((role) => (
          <Card key={role.id} className="space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 font-semibold text-ink-900">
                  {role.name}
                  <span className="tabular text-xs font-normal text-ink-400">{role.key}</span>
                  {role.isSystem ? (
                    <Badge tone="neutral">Ships with the system</Badge>
                  ) : (
                    <Badge tone="success">Custom</Badge>
                  )}
                  {role.customised ? <Badge tone="warn">Edited</Badge> : null}
                </p>
                {role.description ? (
                  <p className="mt-1 text-sm text-ink-500">{role.description}</p>
                ) : null}
                <p className="mt-1 text-xs text-ink-400">
                  {role.permissions.length} permission{role.permissions.length === 1 ? '' : 's'} ·{' '}
                  {role.holders} account{role.holders === 1 ? '' : 's'}
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  tone="neutral"
                  onClick={() => setEditing(editing === role.id ? null : role.id)}
                >
                  {editing === role.id ? 'Close' : 'Edit access'}
                </Button>
                {role.isSystem && role.customised ? (
                  <Button
                    size="sm"
                    tone="neutral"
                    onClick={() => {
                      void run(
                        () =>
                          api(`/api/admin/roles/${role.id}?reset=1`, {
                            method: 'PATCH',
                            body: { permissions: [] },
                          }),
                        `${role.name} is back to its defaults.`,
                      );
                    }}
                  >
                    Reset
                  </Button>
                ) : null}
                {!role.isSystem ? (
                  <Button
                    size="sm"
                    tone="danger"
                    onClick={() => {
                      if (!window.confirm(`Delete the ${role.name} role?`)) return;
                      void run(
                        () => api(`/api/admin/roles/${role.id}`, { method: 'DELETE' }),
                        `${role.name} deleted.`,
                      );
                    }}
                  >
                    Delete
                  </Button>
                ) : null}
              </div>
            </div>

            {editing === role.id ? (
              <PermissionPicker
                areas={areas}
                selected={role.permissions}
                onSave={(selected) =>
                  run(
                    () =>
                      api(`/api/admin/roles/${role.id}`, {
                        method: 'PATCH',
                        body: { permissions: selected },
                      }),
                    `${role.name} updated.`,
                  )
                }
              />
            ) : null}
          </Card>
        ))}
      </div>
    </section>
  );
}

function RoleForm({
  areas,
  onSubmit,
}: {
  areas: [string, PermissionRow[]][];
  onSubmit: (payload: {
    key: string;
    name: string;
    description: string | null;
    permissions: string[];
  }) => Promise<void>;
}): React.ReactElement {
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [description, setDescription] = useState('');

  return (
    <Card className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm font-medium text-ink-700">
          Name
          <input
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              // The key is an identifier, so it is derived rather than typed —
              // one fewer field to get wrong, and still editable below.
              setKey(event.target.value.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_'));
            }}
            aria-label="Role name"
            className="mt-1 w-full rounded-xl border border-ink-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="text-sm font-medium text-ink-700">
          Key
          <input
            value={key}
            onChange={(event) => setKey(event.target.value.toUpperCase())}
            aria-label="Role key"
            className="tabular mt-1 w-full rounded-xl border border-ink-300 px-3 py-2 text-sm"
          />
        </label>
      </div>
      <label className="block text-sm font-medium text-ink-700">
        Description
        <input
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Enrols guests at the door, sells nothing"
          aria-label="Role description"
          className="mt-1 w-full rounded-xl border border-ink-300 px-3 py-2 text-sm"
        />
      </label>

      <PermissionPicker
        areas={areas}
        selected={[]}
        saveLabel="Create role"
        onSave={(permissions) =>
          onSubmit({ key, name, description: description.trim() || null, permissions })
        }
      />
    </Card>
  );
}

function PermissionPicker({
  areas,
  selected,
  onSave,
  saveLabel = 'Save access',
}: {
  areas: [string, PermissionRow[]][];
  selected: string[];
  onSave: (selected: string[]) => Promise<void>;
  saveLabel?: string;
}): React.ReactElement {
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set(selected));
  const [busy, setBusy] = useState(false);

  const toggle = (key: string): void =>
    setChosen((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  return (
    <div className="space-y-3 rounded-xl border border-ink-200 p-3">
      <div className="grid gap-4 sm:grid-cols-2">
        {areas.map(([area, rows]) => (
          <div key={area}>
            <p className="mb-1 text-xs font-bold uppercase tracking-wide text-ink-500">{area}</p>
            <ul className="space-y-1">
              {rows.map((permission) => {
                // A permission the role already holds stays tickable even when
                // it is blocked, so saving an unrelated edit cannot strip it.
                const held = chosen.has(permission.key);
                const locked = !permission.grantable && !held;
                return (
                  <li key={permission.key}>
                    <label
                      className={`flex items-start gap-2 text-sm ${
                        locked ? 'text-ink-400' : 'text-ink-700'
                      }`}
                    >
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={held}
                        disabled={locked}
                        onChange={() => toggle(permission.key)}
                        aria-label={permission.key}
                      />
                      <span className="min-w-0">
                        <span className="tabular block text-xs font-medium">{permission.key}</span>
                        <span className="block text-xs text-ink-400">
                          {permission.description}
                          {locked ? ' · not grantable here' : ''}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-ink-500">{chosen.size} selected</p>
        <Button
          size="sm"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void onSave([...chosen]).finally(() => setBusy(false));
          }}
        >
          {busy ? 'Saving…' : saveLabel}
        </Button>
      </div>
    </div>
  );
}
