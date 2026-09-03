import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { route } from '@/lib/api/handler';
import { ok } from '@/lib/api/responses';
import { auditLogs, users } from '@/lib/db/schema';

export const GET = route({ permission: 'audit.read' }, async ({ request, context }) => {
  const params = new URL(request.url).searchParams;
  const action = params.get('action');
  const targetId = params.get('targetId');
  const actorId = params.get('actorId');
  const search = params.get('q')?.trim();
  const limit = Math.min(Number(params.get('limit') ?? 100), 500);

  const conditions = [eq(auditLogs.eventId, context.eventId)];
  if (action) conditions.push(ilike(auditLogs.action, `${action}%`));
  if (targetId) conditions.push(eq(auditLogs.targetId, targetId));
  if (actorId) conditions.push(eq(auditLogs.actorUserId, actorId));
  if (search) {
    const match = or(ilike(auditLogs.action, `%${search}%`), ilike(users.displayName, `%${search}%`));
    if (match) conditions.push(match);
  }

  const rows = await context.db
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      actorName: users.displayName,
      actorRole: auditLogs.actorRole,
      targetType: auditLogs.targetType,
      targetId: auditLogs.targetId,
      beforeState: auditLogs.beforeState,
      afterState: auditLogs.afterState,
      metadata: auditLogs.metadata,
      ipAddress: auditLogs.ipAddress,
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .leftJoin(users, eq(users.id, auditLogs.actorUserId))
    .where(and(...conditions))
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit);

  const [{ total } = { total: '0' }] = (
    await context.db.execute<{ total: string }>(
      sql`select count(*)::text as total from audit_logs where event_id = ${context.eventId}`,
    )
  ).rows;

  return ok({ data: rows, total: Number(total) });
});
