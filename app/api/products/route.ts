import { route } from '@/lib/api/handler';
import { created } from '@/lib/api/responses';
import { productWriteSchema } from '@/lib/api/schemas';
import { createProduct } from '@/lib/services/provisioning';

export const POST = route(
  {
    permission: 'product.write',
    body: productWriteSchema,
    scope: ({ context, body }) => ({ eventId: context.eventId, storeId: body.storeId }),
  },
  async ({ context, body }) => {
    const result = await createProduct(
      context.db,
      { eventId: context.eventId, ...body },
      context.audit,
    );
    return created(result);
  },
);
