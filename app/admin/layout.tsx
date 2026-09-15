import { redirect } from 'next/navigation';
import Link from 'next/link';
import { requireSession } from '@/lib/auth/server';
import { Badge } from '@/components/ui/primitives';
import { isStaff, visibleNavFor } from '@/lib/admin/nav';
import { getEventSettings } from '@/lib/settings/service';
import { SignOutButton } from '@/components/auth/SignOutButton';

export const dynamic = 'force-dynamic';

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.ReactElement> {
  // Admission is "can you use anything in here", not one named permission.
  // Gating the whole console on `report.read` locked out every custom role
  // that was built to do one job well. Each page still checks its own.
  const session = await requireSession();
  const settings = await getEventSettings(session.db, session.eventId);

  if (!isStaff(session.actor, session.eventId)) redirect('/me?denied=1');

  const visible = visibleNavFor(session.actor, session.eventId, settings.gameModeEnabled);
  if (visible.length === 0) redirect('/me?denied=1');

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
