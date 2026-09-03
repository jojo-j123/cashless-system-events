import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Executor } from '../db/client';
import { notifications } from '../db/schema';
import type { notificationSeverity } from '../db/schema';
import { publish } from '../core/events-bus';

export type Severity = (typeof notificationSeverity.enumValues)[number];

export interface NotificationInput {
  eventId: string | null;
  userId: string;
  type: string;
  title: string;
  body: string;
  severity?: Severity;
  data?: Record<string, unknown>;
}

/**
 * In-app notification. Deliberately the only channel today.
 *
 * The write is best-effort by design: a notification failing must never roll
 * back the money operation that triggered it. Email/push/SMS slot in as extra
 * transports behind this same function without callers changing.
 */
export async function notify(db: Executor, input: NotificationInput): Promise<void> {
  try {
    await db.insert(notifications).values({
      eventId: input.eventId,
      userId: input.userId,
      type: input.type,
      title: input.title,
      body: input.body,
      severity: input.severity ?? 'INFO',
      data: input.data ?? {},
    });

    publish(`user:${input.userId}`, {
      kind: 'notification',
      type: input.type,
      title: input.title,
      body: input.body,
      severity: input.severity ?? 'INFO',
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'notification write failed',
        type: input.type,
        userId: input.userId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

export async function listNotifications(
  db: Executor,
  userId: string,
  options: { unreadOnly?: boolean; limit?: number } = {},
): Promise<(typeof notifications.$inferSelect)[]> {
  const conditions = [eq(notifications.userId, userId)];
  if (options.unreadOnly) conditions.push(isNull(notifications.readAt));

  return db
    .select()
    .from(notifications)
    .where(and(...conditions))
    .orderBy(desc(notifications.createdAt))
    .limit(Math.min(options.limit ?? 50, 200));
}

export async function markNotificationsRead(
  db: Executor,
  userId: string,
  ids?: string[],
): Promise<number> {
  const conditions = [eq(notifications.userId, userId), isNull(notifications.readAt)];
  if (ids && ids.length > 0) {
    conditions.push(sql`${notifications.id} = any(${ids})`);
  }
  const updated = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(...conditions))
    .returning({ id: notifications.id });
  return updated.length;
}

export async function countUnread(db: Executor, userId: string): Promise<number> {
  const result = await db.execute<{ count: string }>(sql`
    select count(*)::text as count from notifications
     where user_id = ${userId} and read_at is null
  `);
  return Number(result.rows[0]?.count ?? 0);
}
