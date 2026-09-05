import { and, count, desc, eq, gt, isNull, max, ne, sql } from 'drizzle-orm';
import type { Database } from '../db/client';
import { auditLogs, eventParticipants, roles, sessions, userRoles, users } from '../db/schema';
import { recordAudit, type AuditContext } from '../audit';
import { ConflictError, ForbiddenError, ValidationError } from '../errors';
import { hashPassword, verifyPassword } from '../auth/password';

export type UserStatus = 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';

export interface UserUsage {
  userId: string;
  displayName: string;
  email: string | null;
  status: UserStatus;
  isSuperAdmin: boolean;
  roles: string[];
  lastLoginAt: string | null;
  liveSessions: number;
  lastSeenAt: string | null;
  lastIp: string | null;
  actions: number;
  lastActionAt: string | null;
}

/**
 * Who is using this system, and what have they been doing.
 *
 * You cannot stop someone who holds the code from running their own copy. What
 * you can see is this: every account, when it last signed in, from where, how
 * many sessions it has open right now, and how much it has actually done. An
 * account being used by someone who should not have it looks different from one
 * that is not — logins at odd hours, a session from an address nobody
 * recognises, activity continuing after an event ended.
 */
export async function getUsageOverview(db: Database, eventId: string): Promise<UserUsage[]> {
  const now = new Date();

  const staff = await db
    .selectDistinct({
      userId: users.id,
      displayName: users.displayName,
      email: users.email,
      status: users.status,
      isSuperAdmin: users.isSuperAdmin,
      lastLoginAt: users.lastLoginAt,
      canSignIn: sql<boolean>`${users.passwordHash} is not null`,
    })
    .from(users)
    .innerJoin(eventParticipants, eq(eventParticipants.userId, users.id))
    .where(and(eq(eventParticipants.eventId, eventId), isNull(users.deletedAt)))
    .orderBy(users.displayName);

  if (staff.length === 0) return [];

  const [roleRows, sessionRows, auditRows] = await Promise.all([
    db
      .select({ userId: userRoles.userId, key: roles.key })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId)),
    db
      .select({
        userId: sessions.userId,
        live: count(),
        lastSeenAt: max(sessions.lastSeenAt),
        lastIp: sql<string | null>`max(${sessions.ipAddress})`,
      })
      .from(sessions)
      .where(and(isNull(sessions.revokedAt), gt(sessions.expiresAt, now)))
      .groupBy(sessions.userId),
    db
      .select({
        userId: auditLogs.actorUserId,
        actions: count(),
        lastActionAt: max(auditLogs.createdAt),
      })
      .from(auditLogs)
      .where(eq(auditLogs.eventId, eventId))
      .groupBy(auditLogs.actorUserId),
  ]);

  const rolesByUser = new Map<string, string[]>();
  for (const row of roleRows) {
    const existing = rolesByUser.get(row.userId) ?? [];
    if (!existing.includes(row.key)) existing.push(row.key);
    rolesByUser.set(row.userId, existing);
  }
  const sessionsByUser = new Map(sessionRows.map((row) => [row.userId, row]));
  const auditByUser = new Map(
    auditRows.filter((row) => row.userId !== null).map((row) => [row.userId as string, row]),
  );

  return staff
    .filter((person) => {
      // "Using this" means holding access to the system, not holding a card.
      // An event has forty attendees for every cashier, and listing them all
      // buries the handful of accounts that can actually sign in and act.
      const held = rolesByUser.get(person.userId) ?? [];
      return person.canSignIn || held.some((key) => key !== 'PARTICIPANT');
    })
    .map((person) => {
      const session = sessionsByUser.get(person.userId);
      const audit = auditByUser.get(person.userId);
      return {
        userId: person.userId,
        displayName: person.displayName,
        email: person.email,
        status: person.status as UserStatus,
        isSuperAdmin: person.isSuperAdmin,
        roles: (rolesByUser.get(person.userId) ?? []).sort(),
        lastLoginAt: person.lastLoginAt?.toISOString() ?? null,
        liveSessions: session?.live ?? 0,
        lastSeenAt: session?.lastSeenAt?.toISOString() ?? null,
        lastIp: session?.lastIp ?? null,
        actions: audit?.actions ?? 0,
        lastActionAt: audit?.lastActionAt?.toISOString() ?? null,
      };
    });
}

/**
 * Suspend or restore an account, and cut its live sessions.
 *
 * Suspending without revoking sessions would leave whoever is already signed in
 * working for as long as their cookie lasts, which is exactly the person you
 * are trying to stop.
 */
export async function setUserStatus(
  db: Database,
  input: { userId: string; status: UserStatus; actorUserId: string },
  context: AuditContext,
): Promise<void> {
  if (input.userId === input.actorUserId) {
    throw new ConflictError('You cannot change the status of your own account.');
  }

  await db.transaction(async (tx) => {
    const [target] = await tx
      .select({ status: users.status, isSuperAdmin: users.isSuperAdmin })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1);
    if (!target) throw new ConflictError('That account no longer exists.');
    if (target.isSuperAdmin) {
      throw new ForbiddenError('A super admin account cannot be suspended from here.');
    }

    await tx.update(users).set({ status: input.status, updatedAt: new Date() }).where(eq(users.id, input.userId));

    if (input.status !== 'ACTIVE') {
      await tx
        .update(sessions)
        .set({ revokedAt: new Date(), revokedReason: `account ${input.status.toLowerCase()}` })
        .where(and(eq(sessions.userId, input.userId), isNull(sessions.revokedAt)));
    }

    await recordAudit(tx, {
      ...context,
      action: 'account.status_changed',
      targetType: 'user',
      targetId: input.userId,
      before: { status: target.status },
      after: { status: input.status },
    });
  });
}

/**
 * Change your own sign-in details.
 *
 * The current password is required even though the caller is already signed in:
 * it is what stops an unattended session from being turned into a permanent
 * takeover of the account that owns the whole system.
 */
export async function changeOwnCredentials(
  db: Database,
  input: {
    userId: string;
    currentPassword: string;
    newEmail?: string | null;
    newPassword?: string | null;
  },
  context: AuditContext,
): Promise<void> {
  const [account] = await db
    .select({ email: users.email, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1);
  if (!account?.passwordHash) throw new ForbiddenError('This account cannot change its password.');

  if (!(await verifyPassword(input.currentPassword, account.passwordHash))) {
    throw new ForbiddenError('That is not your current password.');
  }

  const email = input.newEmail?.trim().toLowerCase() || null;
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new ValidationError('That does not look like an email address.');
  }
  if (input.newPassword && input.newPassword.length < 12) {
    throw new ValidationError('Use at least 12 characters for the new password.');
  }

  await db.transaction(async (tx) => {
    if (email && email !== account.email) {
      const [clash] = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(sql`lower(${users.email}) = ${email}`, ne(users.id, input.userId), isNull(users.deletedAt)))
        .limit(1);
      if (clash) throw new ConflictError('Another account already uses that email address.');
    }

    await tx
      .update(users)
      .set({
        ...(email ? { email } : {}),
        ...(input.newPassword ? { passwordHash: await hashPassword(input.newPassword) } : {}),
        updatedAt: new Date(),
      })
      .where(eq(users.id, input.userId));

    // A password change ends every other session; the current one is left
    // alone so the person doing it is not thrown out mid-change.
    if (input.newPassword) {
      await tx
        .update(sessions)
        .set({ revokedAt: new Date(), revokedReason: 'password changed' })
        .where(and(eq(sessions.userId, input.userId), isNull(sessions.revokedAt)));
    }

    await recordAudit(tx, {
      ...context,
      action: 'account.credentials_changed',
      targetType: 'user',
      targetId: input.userId,
      // Never the values, only which of them moved.
      after: { emailChanged: Boolean(email && email !== account.email), passwordChanged: Boolean(input.newPassword) },
    });
  });
}

export interface WipeSummary {
  tablesCleared: number;
  usersDeleted: number;
}

/**
 * Hand the system to a new client with nothing of the last one left in it.
 *
 * Truncate, not delete. The tables that hold financial history — the ledger,
 * card events, inventory movements, the audit log — carry an append-only
 * trigger that refuses DELETE outright, so cascading a delete from the event
 * row fails on the very tables that most need clearing. TRUNCATE does not fire
 * row triggers, which is the only reason this is possible at all, and is the
 * same mechanism the reset script uses.
 *
 * Roles and permissions stay because they are reference data, not the client's.
 * Super admin accounts stay because otherwise there is nobody left to set the
 * next event up.
 *
 * The audit record is written *after* the wipe rather than before: audit_logs
 * is itself cleared here, so a row written first would be destroyed by the
 * thing it describes. Written last, inside the same transaction, it survives if
 * the wipe succeeds and vanishes with it if the wipe rolls back.
 */
export async function wipeTenantData(
  db: Database,
  input: { actorUserId: string },
  context: AuditContext,
): Promise<WipeSummary> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.execute<{ tablename: string }>(sql`
      select tablename from pg_tables
       where schemaname = 'public'
         and tablename not in ('roles', 'permissions', 'role_permissions', 'users')
    `);
    if (rows.length === 0) throw new ConflictError('There is nothing to reset.');

    const tables = rows.map((row) => `"${row.tablename}"`).join(', ');
    await tx.execute(sql.raw(`truncate ${tables} restart identity cascade`));

    const deletedUsers = await tx
      .delete(users)
      .where(and(eq(users.isSuperAdmin, false), ne(users.id, input.actorUserId)))
      .returning({ id: users.id });

    await recordAudit(tx, {
      ...context,
      eventId: null,
      action: 'tenant.wiped',
      targetType: 'tenant',
      targetId: null,
      after: { tablesCleared: rows.length, usersDeleted: deletedUsers.length },
    });

    return { tablesCleared: rows.length, usersDeleted: deletedUsers.length };
  });
}

/** The most recent things anyone did, newest first. */
export async function getRecentActivity(
  db: Database,
  eventId: string,
  limit = 40,
): Promise<
  { action: string; actor: string | null; targetType: string | null; ipAddress: string | null; createdAt: string }[]
> {
  const rows = await db
    .select({
      action: auditLogs.action,
      actor: users.displayName,
      targetType: auditLogs.targetType,
      ipAddress: auditLogs.ipAddress,
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .leftJoin(users, eq(users.id, auditLogs.actorUserId))
    .where(eq(auditLogs.eventId, eventId))
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit);

  return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
}

/**
 * Set another account's sign-in details.
 *
 * Distinct from `changeOwnCredentials`, which proves who you are with your
 * current password. Nobody can produce a staff member's password on their
 * behalf, so this is authorised by being the super admin instead — and is
 * therefore restricted to that, and refuses to touch another super admin so
 * one owner cannot quietly take another's account.
 *
 * Changing someone's password ends their sessions. Handing a cashier new
 * details while their old login keeps working would defeat the point of
 * changing them.
 */
export async function setAccountCredentials(
  db: Database,
  input: {
    targetUserId: string;
    actorUserId: string;
    newEmail?: string | null;
    newPassword?: string | null;
  },
  context: AuditContext,
): Promise<{ userId: string; email: string | null }> {
  if (!input.newEmail && !input.newPassword) {
    throw new ValidationError('Provide a new email address, a new password, or both.');
  }
  if (input.targetUserId === input.actorUserId) {
    throw new ConflictError('Change your own details in the panel above, with your password.');
  }

  const email = input.newEmail?.trim().toLowerCase() || null;
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new ValidationError('That does not look like an email address.');
  }
  if (input.newPassword && input.newPassword.length < 12) {
    throw new ValidationError('Use at least 12 characters for the new password.');
  }

  return db.transaction(async (tx) => {
    const [target] = await tx
      .select({ email: users.email, isSuperAdmin: users.isSuperAdmin })
      .from(users)
      .where(and(eq(users.id, input.targetUserId), isNull(users.deletedAt)))
      .limit(1);
    if (!target) throw new ConflictError('That account no longer exists.');
    if (target.isSuperAdmin) {
      throw new ForbiddenError('A super admin account can only change its own sign-in details.');
    }

    if (email && email !== target.email) {
      const [clash] = await tx
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            sql`lower(${users.email}) = ${email}`,
            ne(users.id, input.targetUserId),
            isNull(users.deletedAt),
          ),
        )
        .limit(1);
      if (clash) throw new ConflictError('Another account already uses that email address.');
    }

    await tx
      .update(users)
      .set({
        ...(email ? { email } : {}),
        ...(input.newPassword ? { passwordHash: await hashPassword(input.newPassword) } : {}),
        updatedAt: new Date(),
      })
      .where(eq(users.id, input.targetUserId));

    if (input.newPassword) {
      await tx
        .update(sessions)
        .set({ revokedAt: new Date(), revokedReason: 'credentials changed by an administrator' })
        .where(and(eq(sessions.userId, input.targetUserId), isNull(sessions.revokedAt)));
    }

    await recordAudit(tx, {
      ...context,
      action: 'account.credentials_set',
      targetType: 'user',
      targetId: input.targetUserId,
      // Which fields moved, never their values.
      after: { emailChanged: Boolean(email && email !== target.email), passwordChanged: Boolean(input.newPassword) },
    });

    return { userId: input.targetUserId, email: email ?? target.email };
  });
}
