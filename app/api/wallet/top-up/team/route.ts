import { route } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/responses';
import { topUpTeamSchema } from '@/lib/api/schemas';
import { allocateToTeam } from '@/lib/services/wallet';

export const POST = route(
  { permission: 'team.allocate', body: topUpTeamSchema, idempotent: true },
  async ({ context, body, idempotencyKey }) => {
    const { result, replayed } = await allocateToTeam(
      context.db,
      {
        eventId: context.eventId,
        teamId: body.teamId,
        amountPoints: body.amountPoints,
        mode: body.mode,
        reason: body.reason,
        createdBy: context.actor.userId,
      },
      idempotencyKey,
      context.audit,
    );
    return replayed ? ok(result) : created(result);
  },
);
