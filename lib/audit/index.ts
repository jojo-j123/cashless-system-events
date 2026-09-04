import type { Executor } from '../db/client';
import { auditLogs } from '../db/schema';

export interface AuditContext {
  eventId?: string | null;
  actorUserId?: string | null;
  actorRole?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

export interface AuditRecord extends AuditContext {
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
}

/**
 * Write an audit entry.
 *
 * Always pass the transaction handle for actions that change data, so the
 * audit entry commits or rolls back with the action itself. An audit log that
 * can disagree with reality is worse than none.
 *
 * The table is append-only at the database level (see migration 0001).
 */
export async function recordAudit(db: Executor, record: AuditRecord): Promise<void> {
  await db.insert(auditLogs).values({
    eventId: record.eventId ?? null,
    actorUserId: record.actorUserId ?? null,
    actorRole: record.actorRole ?? null,
    action: record.action,
    targetType: record.targetType ?? null,
    targetId: record.targetId ?? null,
    beforeState: redact(record.before),
    afterState: redact(record.after),
    ipAddress: record.ipAddress ?? null,
    userAgent: record.userAgent ?? null,
    requestId: record.requestId ?? null,
    metadata: record.metadata ?? {},
  });
}

const SECRET_KEY_PATTERN =
  /(password|passwordhash|pin|pinhash|token|tokenhash|secret|apikey|apikeyhash|qrsecret|csrf)/i;

/**
 * Audit entries frequently capture whole rows. Strip anything that looks like
 * a credential so the audit log never becomes the softest place to steal one.
 */
function redact(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();

  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    result[key] = SECRET_KEY_PATTERN.test(key) ? '[redacted]' : redact(nested);
  }
  return result;
}
