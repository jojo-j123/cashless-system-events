import Link from 'next/link';
import { requireSession } from '@/lib/auth/server';
import { Badge } from '@/components/ui/primitives';
import type { Permission } from '@/lib/authz/permissions';

const NAV: { group: string; items: { href: string; label: string; permission: Permission }[] }[] = [
  {
    group: 'Overview',
    items: [
      { href: '/admin', label: 'Dashboard', permission: 'report.read' },
      { href: '/admin/ops', label: 'Live operations', permission: 'ops.dashboard' },
    ],
  },
  {
    group: 'People',
    items: [
      { href: '/admin/participants', label: 'Participants', permission: 'participant.read.any' },
      { href: '/admin/cards', label: 'NFC cards', permission: 'card.read' },
    ],
  },
  {
    group: 'Money',
    items: [{ href: '/admin/points', label: 'Points & top-ups', permission: 'wallet.topup' }],
  },
  {
    group: 'Commerce',
    items: [{ href: '/admin/inventory', label: 'Inventory', permission: 'inventory.read' }],
  },
  {
    group: 'Governance',
    items: [{ href: '/admin/audit', label: 'Audit log', permission: 'audit.read' }],
  },
];

export const dynamic = 'force-dynamic';

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.ReactElement> {
  const session = await requireSession('report.read');

  return (
    <div className="min-h-screen bg-ink-100">
      <div className="mx-auto flex max-w-7xl">
        <aside className="hidden w-60 shrink-0 border-r border-ink-200 bg-white lg:block">
          <div className="border-b border-ink-200 p-4">
            <p className="text-sm font-bold text-ink-900">{session.eventName}</p>
            <p className="mt-1">
              <Badge tone={session.eventStatus === 'ACTIVE' ? 'success' : 'warn'}>
                {session.eventStatus}
              </Badge>
            </p>
          </div>

          <nav className="space-y-4 p-4">
            {NAV.map((section) => {
              // Nav is filtered server-side, so a link a user cannot use is
              // never rendered. The real control is in the API, always.
              const visible = section.items.filter((item) =>
                session.actor.can(item.permission, { eventId: session.eventId }),
              );
              if (visible.length === 0) return null;

              return (
                <div key={section.group}>
                  <p className="px-2 text-xs font-semibold uppercase tracking-wide text-ink-400">
                    {section.group}
                  </p>
                  <ul className="mt-1 space-y-0.5">
                    {visible.map((item) => (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          className="block rounded-lg px-2 py-1.5 text-sm font-medium text-ink-700 hover:bg-ink-100"
                        >
                          {item.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </nav>

          <div className="border-t border-ink-200 p-4">
            <p className="text-xs text-ink-500">Signed in as</p>
            <p className="text-sm font-semibold text-ink-800">{session.actor.displayName}</p>
            <p className="mt-1 text-xs text-ink-500">{session.actor.roleKeys.join(', ')}</p>
          </div>
        </aside>

        <main className="min-w-0 flex-1 p-4 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
