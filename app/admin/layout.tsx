import Link from 'next/link';
import { requireSession } from '@/lib/auth/server';
import { Badge } from '@/components/ui/primitives';
import type { Permission } from '@/lib/authz/permissions';
import { getEventSettings } from '@/lib/settings/service';
import { SignOutButton } from '@/components/auth/SignOutButton';

/**
 * One flat list, in the order the desk actually uses it.
 *
 * Grouping five links under five headings was more chrome than navigation.
 * `gameOnly` entries disappear entirely when the event is not running a game,
 * so an operator running a plain cashless bar never sees a leaderboard.
 */
const NAV: {
  href: string;
  label: string;
  permission: Permission;
  gameOnly?: boolean;
  superAdminOnly?: boolean;
}[] = [
  { href: '/admin', label: 'Dashboard', permission: 'report.read' },
  { href: '/admin/enrol', label: 'Add a card', permission: 'card.write' },
  { href: '/admin/points', label: 'Top-ups', permission: 'wallet.topup' },
  { href: '/admin/participants', label: 'People', permission: 'participant.read.any' },
  { href: '/admin/cards', label: 'Cards', permission: 'card.read' },
  { href: '/admin/inventory', label: 'Products', permission: 'inventory.read' },
  { href: '/admin/game', label: 'Game', permission: 'leaderboard.read', gameOnly: true },
  { href: '/admin/audit', label: 'Audit log', permission: 'audit.read' },
  { href: '/admin/system', label: 'System', permission: 'report.read', superAdminOnly: true },
];

export const dynamic = 'force-dynamic';

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.ReactElement> {
  const session = await requireSession('report.read');
  const settings = await getEventSettings(session.db, session.eventId);

  const visible = NAV.filter(
    (item) =>
      (!item.gameOnly || settings.gameModeEnabled) &&
      (!item.superAdminOnly || session.actor.isSuperAdmin) &&
      // Filtered server-side, so a link a user cannot use is never rendered.
      // The real control is in the API, always.
      session.actor.canAnywhere(item.permission, session.eventId),
  );

  return (
    <div className="min-h-screen bg-ink-100">
      {/*
        The desk runs on a phone or a tablet, so the console cannot live only in
        a sidebar that disappears below `lg`. Same links, same filtering, laid
        out to scroll sideways under a header that keeps the way out reachable.
      */}
      <header className="border-b border-ink-200 bg-white lg:hidden">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-bold text-ink-900">{session.eventName}</p>
            <p className="truncate text-xs text-ink-500">{session.actor.displayName}</p>
          </div>
          <SignOutButton />
        </div>
        <nav className="flex gap-1 overflow-x-auto px-4 pb-3">
          {visible.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="whitespace-nowrap rounded-lg bg-ink-50 px-3 py-2 text-sm font-medium text-ink-700"
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </header>

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

          <nav className="space-y-0.5 p-4">
            {visible.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="block rounded-lg px-2 py-2 text-sm font-medium text-ink-700 hover:bg-ink-100"
              >
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="border-t border-ink-200 p-4">
            <p className="text-xs text-ink-500">Signed in as</p>
            <p className="text-sm font-semibold text-ink-800">{session.actor.displayName}</p>
            <p className="mt-1 text-xs text-ink-500">{session.actor.roleKeys.join(', ')}</p>
            <div className="mt-3">
              <SignOutButton fullWidth />
            </div>
          </div>
        </aside>

        <main className="min-w-0 flex-1 p-4 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
