import { and, eq, inArray, isNull } from 'drizzle-orm';
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

  // Scoped to no store at all means there is nothing to sell at, which is a
  // different thing from being scoped to every store.
  const storeRows =
    allowedStores !== null && allowedStores.length === 0
      ? []
      : await session.db
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
              ...(allowedStores === null ? [] : [inArray(stores.id, allowedStores)]),
            ),
          )
          .orderBy(stores.name);

  const firstStore = storeRows[0];
  const [terminal] = firstStore
    ? await session.db
        .select({ id: terminals.id })
        .from(terminals)
        .where(
          and(
            eq(terminals.eventId, session.eventId),
            eq(terminals.isDisabled, false),
            eq(terminals.storeId, firstStore.id),
          ),
        )
        .limit(1)
    : [];

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
