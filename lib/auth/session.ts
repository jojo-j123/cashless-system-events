import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Database, Executor } from '../db/client';
import { sessions, users } from '../db/schema';
import { UnauthenticatedError } from '../errors';
import { generateToken, hashToken } from './tokens';

export const SESSION_COOKIE = 'cashless_session';
export const CSRF_COOKIE = 'cashless_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export interface IssuedSession {
  sessionId: string;
  token: string;
  csrfToken: string;
  expiresAt: Date;
}

export interface SessionRecord {
  sessionId: string;
  userId: string;
  csrfTokenHash: string;
  expiresAt: Date;
}

export async function createSession(
  db: Executor,
  input: {
    userId: string;
    ttlMinutes: number;
    userAgent?: string | null;
    ipAddress?: string | null;
    terminalId?: string | null;
  },
): Promise<IssuedSession> {
  const token = generateToken(32);
  const csrfToken = generateToken(24);
  const expiresAt = new Date(Date.now() + input.ttlMinutes * 60_000);

  const [row] = await db
    .insert(sessions)
    .values({
      userId: input.userId,
      tokenHash: hashToken(token),
      csrfTokenHash: hashToken(csrfToken),
      userAgent: input.userAgent ?? null,
      ipAddress: input.ipAddress ?? null,
      terminalId: input.terminalId ?? null,
      expiresAt,
    })
    .returning({ id: sessions.id });

  if (!row) throw new Error('Failed to create session');
  return { sessionId: row.id, token, csrfToken, expiresAt };
}

/**
 * Resolve a raw cookie token to a live session.
 *
 * Returns null (never throws) for anything invalid, so callers decide whether
 * anonymous access is acceptable for that route.
 */
export async function resolveSession(
  db: Executor,
  token: string | undefined,
): Promise<SessionRecord | null> {
  if (!token) return null;

  const [row] = await db
    .select({
      id: sessions.id,
      userId: sessions.userId,
      csrfTokenHash: sessions.csrfTokenHash,
      expiresAt: sessions.expiresAt,
      revokedAt: sessions.revokedAt,
      userStatus: users.status,
      userDeletedAt: users.deletedAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.tokenHash, hashToken(token)))
    .limit(1);

  if (!row) return null;
  if (row.revokedAt !== null) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;
  // A suspended or deleted user's existing sessions die immediately.
  if (row.userStatus !== 'ACTIVE' || row.userDeletedAt !== null) return null;

  return {
    sessionId: row.id,
    userId: row.userId,
    csrfTokenHash: row.csrfTokenHash,
    expiresAt: row.expiresAt,
  };
}

/** Fire-and-forget liveness update; failure must never break a request. */
export async function touchSession(db: Database, sessionId: string): Promise<void> {
  try {
    await db
      .update(sessions)
      .set({ lastSeenAt: new Date() })
      .where(eq(sessions.id, sessionId));
  } catch {
    // Intentionally ignored.
  }
}

export async function revokeSession(
  db: Executor,
  sessionId: string,
  reason: string,
): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
}

/** Used when suspending a user or on a password change. */
export async function revokeAllSessionsForUser(
  db: Executor,
  userId: string,
  reason: string,
): Promise<number> {
  const revoked = await db
    .update(sessions)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });
  return revoked.length;
}

export async function pruneExpiredSessions(db: Executor): Promise<void> {
  await db.execute(
    sql`delete from sessions where expires_at < now() - interval '30 days'`,
  );
}

export function assertAuthenticated<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new UnauthenticatedError();
  return value;
}
