import { and, eq, isNull, sql } from 'drizzle-orm';
import { requireSession } from '@/lib/auth/server';
import { nfcCards, stores, users } from '@/lib/db/schema';
import { PosTerminal } from '@/components/pos/PosTerminal';
import { terminals } from '@/lib/db/schema';

export const metadata = { title: 'POS · Cashless Event Platform' };
export const dynamic = 'force-dynamic';

export default async function PosPage(): Promise<React.ReactElement> {
  const session = await requireSession('pos.operate');

  // Only the stores this cashier is actually scoped to. A cashier at the food
  // court never even sees the merch stand in the picker.
  const allowedStores = session.actor.storesFor('pos.operate', session.eventId);

  const storeRows = await session.db
    .select({
      id: stores.id,
      name: stores.name,
      isOpen: stores.isOpen,
      isActive: stores.isActive,
    })
    .from(stores)
    .where(
      and(
        eq(stores.eventId, session.eventId),
        isNull(stores.deletedAt),
        eq(stores.isActive, true),
        allowedStores === null ? sql`true` : sql`${stores.id} = any(${allowedStores})`,
      ),
    )
    .orderBy(stores.name);

  const [terminal] = await session.db
    .select({ id: terminals.id })
    .from(terminals)
    .where(
      and(
        eq(terminals.eventId, session.eventId),
        eq(terminals.isDisabled, false),
        storeRows[0] ? eq(terminals.storeId, storeRows[0].id) : sql`true`,
      ),
    )
    .limit(1);

  // The simulator list is only ever populated when the flag is on. In
  // production this is an empty array and the panel never renders.
  const simulatorCards =
    process.env.NEXT_PUBLIC_ENABLE_NFC_SIMULATOR === 'true'
      ? await session.db
          .select({
            id: nfcCards.id,
            cardRef: nfcCards.cardRef,
            displayName: users.displayName,
          })
          .from(nfcCards)
          .leftJoin(users, eq(users.id, nfcCards.assignedUserId))
          .where(and(eq(nfcCards.eventId, session.eventId), eq(nfcCards.status, 'ACTIVE')))
          .limit(8)
      : [];

  return (
    <PosTerminal
      stores={storeRows}
      simulatorCards={simulatorCards}
      terminalId={terminal?.id ?? null}
    />
  );
}
