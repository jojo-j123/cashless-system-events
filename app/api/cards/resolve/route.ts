import { route } from '@/lib/api/handler';
import { ok } from '@/lib/api/responses';
import { cardCredentialSchema } from '@/lib/api/schemas';
import { resolveCard } from '@/lib/services/cards';
import { RATE_LIMITS } from '@/lib/core/rate-limit';

/**
 * The tap endpoint. Every reader — Web NFC, USB keyboard-wedge, the
 * development simulator — lands here with the same shape, and goes through
 * identical server-side validation.
 */
export const POST = route(
  {
    permission: 'card.resolve',
    body: cardCredentialSchema,
    rateLimit: RATE_LIMITS.cardTap,
    scope: ({ context, body }) => ({
      eventId: context.eventId,
      storeId: body.storeId ?? null,
    }),
  },
  async ({ context, body }) => {
    const resolved = await resolveCard(
      context.db,
      context.eventId,
      { kind: body.kind, value: body.value },
      {
        ...context.audit,
        terminalId: body.terminalId ?? null,
        storeId: body.storeId ?? null,
      },
    );
    return ok(resolved);
  },
);
