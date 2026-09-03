import { route } from '@/lib/api/handler';
import { ok } from '@/lib/api/responses';
import { inventoryAdjustSchema } from '@/lib/api/schemas';
import { adjustStock } from '@/lib/services/inventory';

export const POST = route(
  { permission: 'inventory.adjust', body: inventoryAdjustSchema },
  async ({ context, body }) => {
    const result = await adjustStock(
      context.db,
      {
        eventId: context.eventId,
        productId: body.productId,
        quantityDelta: body.quantityDelta,
        type: body.type,
        reason: body.reason,
        actorUserId: context.actor.userId,
      },
      context.audit,
    );
    return ok(result);
  },
);
