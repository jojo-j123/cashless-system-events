import { and, asc, eq, isNull } from 'drizzle-orm';
import { requireSession } from '@/lib/auth/server';
import { teams } from '@/lib/db/schema';
import { EnrolDesk } from '@/components/admin/EnrolDesk';

export const metadata = { title: 'Add a card · Cashless Event Platform' };
export const dynamic = 'force-dynamic';

export default async function EnrolPage(): Promise<React.ReactElement> {
  const session = await requireSession('card.write');

  const teamRows = await session.db
    .select({ id: teams.id, name: teams.name })
    .from(teams)
    .where(and(eq(teams.eventId, session.eventId), isNull(teams.deletedAt)))
    .orderBy(asc(teams.name));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-ink-900">Add a card</h1>
        <p className="mt-1 text-sm text-ink-500">
          Name, team, opening balance, then tap the tag.
        </p>
      </div>
      <EnrolDesk teams={teamRows} />
    </div>
  );
}
