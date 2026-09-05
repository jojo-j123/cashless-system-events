import { notFound } from 'next/navigation';
import { requireSession } from '@/lib/auth/server';
import { getRecentActivity, getUsageOverview } from '@/lib/services/tenancy';
import { SystemConsole } from '@/components/admin/SystemConsole';

export const metadata = { title: 'System · Cashless Event Platform' };
export const dynamic = 'force-dynamic';

/**
 * The owner's console.
 *
 * 404 rather than 403 for anyone who is not a super admin: a client poking at
 * URLs learns nothing about what they cannot reach.
 */
export default async function SystemPage(): Promise<React.ReactElement> {
  const session = await requireSession('report.read');
  if (!session.actor.isSuperAdmin) notFound();

  const [usage, activity] = await Promise.all([
    getUsageOverview(session.db, session.eventId),
    getRecentActivity(session.db, session.eventId, 40),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-ink-900">System</h1>
        <p className="mt-1 text-sm text-ink-500">
          Your sign-in details, who is using this, and the reset for a new client.
        </p>
      </div>
      <SystemConsole usage={usage} activity={activity} />
    </div>
  );
}
