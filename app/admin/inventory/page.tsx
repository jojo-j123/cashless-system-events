import { requireSession } from '@/lib/auth/server';
import { listStock } from '@/lib/services/inventory';
import { InventoryManager } from '@/components/admin/InventoryManager';

export const metadata = { title: 'Inventory · Admin' };
export const dynamic = 'force-dynamic';

export default async function InventoryPage(): Promise<React.ReactElement> {
  const session = await requireSession('inventory.read');
  const stock = await listStock(session.db, session.eventId);

  return (
    <InventoryManager
      stock={stock}
      canAdjust={session.actor.can('inventory.adjust', { eventId: session.eventId })}
    />
  );
}
