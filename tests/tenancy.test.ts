import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { closeDb } from '../lib/db/client';
import { buildWorld, prepareDatabase, type TestWorld } from './helpers';
import {
  changeOwnCredentials,
  getUsageOverview,
  setUserStatus,
  wipeTenantData,
} from '../lib/services/tenancy';
import { createParticipant } from '../lib/services/provisioning';
import { auditLogs, events, sessions, users } from '../lib/db/schema';
import { hashToken, generateToken } from '../lib/auth/tokens';
import { verifyPassword } from '../lib/auth/password';

let world: TestWorld;
const ctx = { requestId: 'test' };

beforeEach(async () => {
  const db = await prepareDatabase();
  world = await buildWorld(db);
});

afterAll(async () => {
  await closeDb();
});

async function withPassword(password: string): Promise<string> {
  const person = await createParticipant(
    world.db,
    {
      eventId: world.eventId,
      displayName: 'Owner Account',
      email: `owner-${Math.random()}@test.local`,
      password,
    },
    ctx,
  );
  return person.userId;
}

/** A live session row, so revocation has something real to act on. */
async function openSession(userId: string): Promise<string> {
  const [row] = await world.db
    .insert(sessions)
    .values({
      userId,
      tokenHash: hashToken(generateToken()),
      csrfTokenHash: hashToken(generateToken()),
      expiresAt: new Date(Date.now() + 3_600_000),
    })
    .returning({ id: sessions.id });
  if (!row) throw new Error('no session');
  return row.id;
}

async function liveSessionCount(userId: string): Promise<number> {
  const rows = await world.db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
  return rows.length;
}

describe('changing your own sign-in details', () => {
  it('refuses without the correct current password', async () => {
    const userId = await withPassword('correct-horse-battery');

    await expect(
      changeOwnCredentials(
        world.db,
        { userId, currentPassword: 'wrong-one', newPassword: 'brand-new-password' },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('changes the password and signs every session out', async () => {
    const userId = await withPassword('correct-horse-battery');
    await openSession(userId);
    await openSession(userId);
    expect(await liveSessionCount(userId)).toBe(2);

    await changeOwnCredentials(
      world.db,
      { userId, currentPassword: 'correct-horse-battery', newPassword: 'a-much-better-password' },
      ctx,
    );

    const [account] = await world.db
      .select({ hash: users.passwordHash })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    expect(await verifyPassword('a-much-better-password', account?.hash ?? '')).toBe(true);
    expect(await liveSessionCount(userId)).toBe(0);
  });

  it('changes the email address', async () => {
    const userId = await withPassword('correct-horse-battery');

    await changeOwnCredentials(
      world.db,
      { userId, currentPassword: 'correct-horse-battery', newEmail: 'New.Owner@Example.com' },
      ctx,
    );

    const [account] = await world.db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    expect(account?.email).toBe('new.owner@example.com');
  });

  it('refuses an email another live account already uses', async () => {
    const userId = await withPassword('correct-horse-battery');
    const taken = `taken-${Math.random()}@test.local`;
    await createParticipant(
      world.db,
      { eventId: world.eventId, displayName: 'Someone Else', email: taken },
      ctx,
    );

    await expect(
      changeOwnCredentials(
        world.db,
        { userId, currentPassword: 'correct-horse-battery', newEmail: taken },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('never writes the new secret into the audit trail', async () => {
    const userId = await withPassword('correct-horse-battery');
    await changeOwnCredentials(
      world.db,
      { userId, currentPassword: 'correct-horse-battery', newPassword: 'a-much-better-password' },
      ctx,
    );

    const rows = await world.db
      .select({ after: auditLogs.afterState })
      .from(auditLogs)
      .where(eq(auditLogs.action, 'account.credentials_changed'));

    expect(rows.length).toBe(1);
    expect(JSON.stringify(rows[0]?.after)).not.toContain('a-much-better-password');
  });
});

describe('suspending an account', () => {
  it('cuts the live sessions along with the status', async () => {
    await openSession(world.cashierId);
    expect(await liveSessionCount(world.cashierId)).toBe(1);

    await setUserStatus(
      world.db,
      { userId: world.cashierId, status: 'SUSPENDED', actorUserId: world.adminId },
      ctx,
    );

    const [account] = await world.db
      .select({ status: users.status })
      .from(users)
      .where(eq(users.id, world.cashierId))
      .limit(1);
    expect(account?.status).toBe('SUSPENDED');
    // Leaving the cookie alive would keep the very person you are stopping
    // working until it expired.
    expect(await liveSessionCount(world.cashierId)).toBe(0);
  });

  it('will not let you suspend yourself', async () => {
    await expect(
      setUserStatus(
        world.db,
        { userId: world.adminId, status: 'SUSPENDED', actorUserId: world.adminId },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('will not suspend a super admin', async () => {
    await world.db.update(users).set({ isSuperAdmin: true }).where(eq(users.id, world.financeId));

    await expect(
      setUserStatus(
        world.db,
        { userId: world.financeId, status: 'SUSPENDED', actorUserId: world.adminId },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('restores a suspended account', async () => {
    await setUserStatus(
      world.db,
      { userId: world.cashierId, status: 'SUSPENDED', actorUserId: world.adminId },
      ctx,
    );
    await setUserStatus(
      world.db,
      { userId: world.cashierId, status: 'ACTIVE', actorUserId: world.adminId },
      ctx,
    );

    const [account] = await world.db
      .select({ status: users.status })
      .from(users)
      .where(eq(users.id, world.cashierId))
      .limit(1);
    expect(account?.status).toBe('ACTIVE');
  });
});

describe('usage overview', () => {
  it('reports every participant with their roles and live sessions', async () => {
    await openSession(world.adminId);

    const usage = await getUsageOverview(world.db, world.eventId);
    const admin = usage.find((row) => row.userId === world.adminId);

    expect(admin).toBeDefined();
    expect(admin?.roles).toContain('ADMIN');
    expect(admin?.liveSessions).toBe(1);
    // buildWorld provisions through the real services, so the admin has an
    // audit trail behind them.
    expect(admin?.actions).toBeGreaterThan(0);
  });

  it('does not count a revoked session as live', async () => {
    await openSession(world.cashierId);
    await setUserStatus(
      world.db,
      { userId: world.cashierId, status: 'SUSPENDED', actorUserId: world.adminId },
      ctx,
    );

    const usage = await getUsageOverview(world.db, world.eventId);
    expect(usage.find((row) => row.userId === world.cashierId)?.liveSessions).toBe(0);
  });
});

describe('resetting for a new client', () => {
  it('deletes the events and everyone in them, keeping the super admin', async () => {
    await world.db.update(users).set({ isSuperAdmin: true }).where(eq(users.id, world.adminId));

    const summary = await wipeTenantData(world.db, { actorUserId: world.adminId }, ctx);

    expect(summary.tablesCleared).toBeGreaterThan(0);
    expect(summary.usersDeleted).toBeGreaterThan(0);

    const remainingEvents = await world.db.select({ id: events.id }).from(events);
    expect(remainingEvents.length).toBe(0);

    const remainingUsers = await world.db.select({ id: users.id }).from(users);
    expect(remainingUsers.map((row) => row.id)).toEqual([world.adminId]);
  });

  it('leaves behind the record that it happened', async () => {
    await world.db.update(users).set({ isSuperAdmin: true }).where(eq(users.id, world.adminId));
    await wipeTenantData(world.db, { actorUserId: world.adminId }, ctx);

    // audit_logs.event_id nulls rather than cascades, so the row describing the
    // wipe outlives the event it destroyed.
    const rows = await world.db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(eq(auditLogs.action, 'tenant.wiped'));

    expect(rows.length).toBe(1);
  });

  it('takes the money with it — no orphaned wallets or ledger rows', async () => {
    await world.db.update(users).set({ isSuperAdmin: true }).where(eq(users.id, world.adminId));
    await wipeTenantData(world.db, { actorUserId: world.adminId }, ctx);

    // A stray row here would mean the next client's system still holds the
    // last one's money.
    const { rows } = await world.db.execute<{ accounts: string; entries: string; cards: string }>(sql`
      select (select count(*) from accounts)::text       as accounts,
             (select count(*) from ledger_entries)::text as entries,
             (select count(*) from nfc_cards)::text      as cards
    `);

    expect(rows[0]).toEqual({ accounts: '0', entries: '0', cards: '0' });
  });
});
