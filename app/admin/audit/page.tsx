import { desc, eq } from 'drizzle-orm';
import { requireSession } from '@/lib/auth/server';
import { auditLogs, users } from '@/lib/db/schema';
import { Alert, Badge, Card, EmptyState } from '@/components/ui/primitives';

export const metadata = { title: 'Audit log · Admin' };
export const dynamic = 'force-dynamic';

const SENSITIVE = new Set([
  'wallet.manual_adjustment',
  'purchase.refunded',
  'card.lost',
  'card.suspended',
  'settings.updated',
  'product.price_changed',
  'approval.approved',
]);

export default async function AuditPage(): Promise<React.ReactElement> {
  const session = await requireSession('audit.read');

  const rows = await session.db
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      actorName: users.displayName,
      actorRole: auditLogs.actorRole,
      targetType: auditLogs.targetType,
      targetId: auditLogs.targetId,
      metadata: auditLogs.metadata,
      ipAddress: auditLogs.ipAddress,
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .leftJoin(users, eq(users.id, auditLogs.actorUserId))
    .where(eq(auditLogs.eventId, session.eventId))
    .orderBy(desc(auditLogs.createdAt))
    .limit(200);

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-bold text-ink-900">Audit log</h1>
        <p className="text-sm text-ink-500">
          Append-only at the database level. Entries cannot be edited or deleted by anyone,
          including an administrator.
        </p>
      </header>

      <Alert tone="brand" title="Showing the 200 most recent entries">
        Filter and export the full history through the API.
      </Alert>

      {rows.length === 0 ? (
        <EmptyState title="Nothing logged yet" description="Actions will appear here." />
      ) : (
        <Card padded={false}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
                <tr>
                  <th className="px-4 py-2">When</th>
                  <th className="px-4 py-2">Action</th>
                  <th className="px-4 py-2">Actor</th>
                  <th className="px-4 py-2">Target</th>
                  <th className="px-4 py-2">Detail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-200">
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="tabular whitespace-nowrap px-4 py-2 text-xs text-ink-500">
                      {new Date(row.createdAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-2">
                      <Badge tone={SENSITIVE.has(row.action) ? 'warn' : 'neutral'}>
                        {row.action}
                      </Badge>
                    </td>
                    <td className="px-4 py-2">
                      <p className="text-ink-800">{row.actorName ?? 'system'}</p>
                      <p className="text-xs text-ink-400">{row.actorRole ?? ''}</p>
                    </td>
                    <td className="px-4 py-2 text-xs text-ink-500">{row.targetType ?? '—'}</td>
                    <td className="max-w-md px-4 py-2 text-xs text-ink-500">
                      <code className="break-all">
                        {JSON.stringify(row.metadata ?? {}).slice(0, 160)}
                      </code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
