import { and, eq, isNull } from 'drizzle-orm';
import { route } from '@/lib/api/handler';
import { ok } from '@/lib/api/responses';
import { inventory, productCategories, products } from '@/lib/db/schema';
import { ValidationError } from '@/lib/errors';

export const GET = route({ permission: 'product.read' }, async ({ context, params }) => {
  const storeId = params.id;
  if (!storeId) throw new ValidationError('A store id is required.');

  const rows = await context.db
    .select({
      id: products.id,
      sku: products.sku,
      name: products.name,
      description: products.description,
      imageUrl: products.imageUrl,
      pricePoints: products.pricePoints,
      isActive: products.isActive,
      maxPerPurchase: products.maxPerPurchase,
      restrictedToTeamId: products.restrictedToTeamId,
      categoryId: products.categoryId,
      categoryName: productCategories.name,
      quantityOnHand: inventory.quantityOnHand,
      trackInventory: inventory.trackInventory,
      lowStockThreshold: inventory.lowStockThreshold,
    })
    .from(products)
    .leftJoin(inventory, eq(inventory.productId, products.id))
    .leftJoin(productCategories, eq(productCategories.id, products.categoryId))
    .where(
      and(
        eq(products.storeId, storeId),
        eq(products.eventId, context.eventId),
        isNull(products.deletedAt),
      ),
    )
    .orderBy(products.sortOrder, products.name);

  return ok({
    data: rows.map((row) => ({
      ...row,
      // A cashier needs to know what they can actually sell, not raw stock.
      sellable:
        row.isActive && (!row.trackInventory || (row.quantityOnHand ?? 0) > 0),
      isLow:
        row.trackInventory === true &&
        (row.quantityOnHand ?? 0) <= (row.lowStockThreshold ?? 0),
    })),
  });
});
