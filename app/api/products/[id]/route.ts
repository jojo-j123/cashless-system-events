import { and, eq } from 'drizzle-orm';
import { route } from '@/lib/api/handler';
import { ok } from '@/lib/api/responses';
import { productPatchSchema } from '@/lib/api/schemas';
import { products } from '@/lib/db/schema';
import { recordAudit } from '@/lib/audit';
import { NotFoundError, ValidationError } from '@/lib/errors';

export const PATCH = route(
  { permission: 'product.write', body: productPatchSchema },
  async ({ context, body, params }) => {
    const productId = params.id;
    if (!productId) throw new ValidationError('A product id is required.');

    return context.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(products)
        .where(and(eq(products.id, productId), eq(products.eventId, context.eventId)))
        .limit(1);
      if (!existing) throw new NotFoundError('That product');

      // Price changes are scoped to the product's own store, so a manager
      // cannot reprice a store they do not run.
      context.actor.require('product.write', {
        eventId: context.eventId,
        storeId: existing.storeId,
      });

      const [updated] = await tx
        .update(products)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.pricePoints !== undefined ? { pricePoints: body.pricePoints } : {}),
          ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
          ...(body.maxPerPurchase !== undefined ? { maxPerPurchase: body.maxPerPurchase } : {}),
          ...(body.categoryId !== undefined ? { categoryId: body.categoryId } : {}),
        })
        .where(eq(products.id, productId))
        .returning();

      // A price change is a sensitive action: capture exactly what moved.
      await recordAudit(tx, {
        ...context.audit,
        action:
          body.pricePoints !== undefined && body.pricePoints !== existing.pricePoints
            ? 'product.price_changed'
            : 'product.updated',
        targetType: 'product',
        targetId: productId,
        before: existing,
        after: updated,
      });

      return ok(updated);
    });
  },
);
