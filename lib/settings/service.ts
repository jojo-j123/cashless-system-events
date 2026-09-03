import { eq } from 'drizzle-orm';
import type { Executor } from '../db/client';
import { eventSettings } from '../db/schema';
import {
  DEFAULT_EVENT_SETTINGS,
  eventSettingsPatchSchema,
  eventSettingsSchema,
  type EventSettings,
  type EventSettingsPatch,
} from './schema';

/**
 * Settings are read on nearly every money operation, so they are cached in
 * process. The TTL is short because an operator changing a limit mid-event
 * expects it to take effect promptly, and a stale limit is a real risk.
 *
 * Balances are never cached this way — see docs/architecture.md.
 */
const CACHE_TTL_MS = 5_000;
const cache = new Map<string, { value: EventSettings; expiresAt: number }>();

export function invalidateSettingsCache(eventId?: string): void {
  if (eventId) cache.delete(eventId);
  else cache.clear();
}

export async function getEventSettings(
  db: Executor,
  eventId: string,
): Promise<EventSettings> {
  const cached = cache.get(eventId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const [row] = await db
    .select({ settings: eventSettings.settings })
    .from(eventSettings)
    .where(eq(eventSettings.eventId, eventId))
    .limit(1);

  // A malformed stored blob must not take the event down: fall back to
  // defaults for the fields that fail and keep the ones that parse.
  const parsed = eventSettingsSchema.safeParse(row?.settings ?? {});
  const value = parsed.success ? parsed.data : DEFAULT_EVENT_SETTINGS;

  cache.set(eventId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

export async function updateEventSettings(
  db: Executor,
  eventId: string,
  patch: EventSettingsPatch,
  updatedBy: string | null,
): Promise<EventSettings> {
  const validated = eventSettingsPatchSchema.parse(patch);
  const current = await getEventSettings(db, eventId);
  const next = eventSettingsSchema.parse({ ...current, ...validated });

  await db
    .insert(eventSettings)
    .values({ eventId, settings: next, updatedBy })
    .onConflictDoUpdate({
      target: eventSettings.eventId,
      set: { settings: next, updatedBy, updatedAt: new Date() },
    });

  invalidateSettingsCache(eventId);
  return next;
}

export { DEFAULT_EVENT_SETTINGS };
export type { EventSettings, EventSettingsPatch };
