import { and, desc, eq, sql } from 'drizzle-orm';
import { route } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/responses';
import { z } from 'zod';
import { stores, terminals, users } from '@/lib/db/schema';
import { registerTerminal } from '@/lib/services/provisioning';

const registerSchema = z.object({
  storeId: z.string().uuid().nullish(),
  name: z.string().trim().min(1).max(120),
});

export const GET = route({ permission: 'terminal.read' }, async ({ context }) => {
  const rows = await context.db
    .select({
      id: terminals.id,
      terminalRef: terminals.terminalRef,
      name: terminals.name,
      storeName: stores.name,
      appVersion: terminals.appVersion,
      lastHeartbeatAt: terminals.lastHeartbeatAt,
      lastTransactionAt: terminals.lastTransactionAt,
      isDisabled: terminals.isDisabled,
      cashierName: users.displayName,
      // Derived, not stored: a stored status would go stale the moment a
      // terminal dies without telling us.
      status: sql<string>`case
        when ${terminals.isDisabled} then 'DISABLED'
        when ${terminals.lastHeartbeatAt} is null then 'OFFLINE'
        when ${terminals.lastHeartbeatAt} > now() - interval '2 minutes' then 'ONLINE'
        when ${terminals.lastHeartbeatAt} > now() - interval '15 minutes' then 'ERROR'
        else 'OFFLINE' end`,
    })
    .from(terminals)
    .leftJoin(stores, eq(stores.id, terminals.storeId))
    .leftJoin(users, eq(users.id, terminals.assignedCashierUserId))
    .where(eq(terminals.eventId, context.eventId))
    .orderBy(desc(terminals.lastHeartbeatAt));

  return ok({ data: rows });
});

export const POST = route(
  { permission: 'terminal.write', body: registerSchema },
  async ({ context, body }) => {
    const result = await registerTerminal(
      context.db,
      { eventId: context.eventId, storeId: body.storeId ?? null, name: body.name },
      context.audit,
    );
    // The API key is shown once. It is stored only as a hash.
    return created({ ...result, warning: 'Store this API key now; it cannot be retrieved again.' });
  },
);

export const PATCH = route(
  {
    permission: 'terminal.write',
    body: z.object({ terminalId: z.string().uuid(), isDisabled: z.boolean() }),
  },
  async ({ context, body }) => {
    await context.db
      .update(terminals)
      .set({ isDisabled: body.isDisabled })
      .where(and(eq(terminals.id, body.terminalId), eq(terminals.eventId, context.eventId)));
    return ok({ terminalId: body.terminalId, isDisabled: body.isDisabled });
  },
);
