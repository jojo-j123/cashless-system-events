import { route } from '@/lib/api/handler';
import { ok } from '@/lib/api/responses';
import { eventSettingsPatchSchema } from '@/lib/settings/schema';
import { getEventSettings, updateEventSettings } from '@/lib/settings/service';
import { recordAudit } from '@/lib/audit';

export const GET = route({ permission: 'settings.read' }, async ({ context }) => {
  return ok(await getEventSettings(context.db, context.eventId));
});

export const PATCH = route(
  { permission: 'settings.write', body: eventSettingsPatchSchema },
  async ({ context, body }) => {
    const before = await getEventSettings(context.db, context.eventId);
    const after = await updateEventSettings(
      context.db,
      context.eventId,
      body,
      context.actor.userId,
    );

    await recordAudit(context.db, {
      ...context.audit,
      action: 'settings.updated',
      targetType: 'event',
      targetId: context.eventId,
      before,
      after,
    });

    return ok(after);
  },
);
