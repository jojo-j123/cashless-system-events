import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb } from '../lib/db/client';
import { buildWorld, prepareDatabase, type TestWorld } from './helpers';
import { syncRolesAndPermissions } from '../lib/db/bootstrap';
import {
  createRole,
  deleteRole,
  listRoles,
  permissionCatalogue,
  resetRoleToDefaults,
  setRolePermissions,
} from '../lib/services/roles';
import { createStaffAccount, deleteStaffAccount, setStaffRole } from '../lib/services/tenancy';
import { loadActor } from '../lib/authz/actor';
import { isStaff, landingPathFor, visibleNavFor } from '../lib/admin/nav';
import { verifyPassword } from '../lib/auth/password';
import { users } from '../lib/db/schema';

let world: TestWorld;
const ctx = { requestId: 'test' };

beforeEach(async () => {
  world = await buildWorld(await prepareDatabase());
});

afterAll(async () => {
  await closeDb();
});

const roleByKey = async (key: string) =>
  (await listRoles(world.db)).find((role) => role.key === key);

describe('custom roles', () => {
  it('creates a role and grants it to an account that can then sign in', async () => {
    await createRole(
      world.db,
      {
        key: 'RECEPTION',
        name: 'Reception',
        description: 'Enrols guests, sells nothing.',
        permissions: ['participant.read.any', 'card.write', 'card.assign'],
      },
      ctx,
    );

    const role = await roleByKey('RECEPTION');
    expect(role?.isSystem).toBe(false);
    expect(role?.permissions).toEqual(['card.assign', 'card.write', 'participant.read.any']);

    const account = await createStaffAccount(
      world.db,
      {
        eventId: world.eventId,
        displayName: 'Front Desk',
        email: 'reception@test.local',
        password: 'a-long-enough-password',
        roleKey: 'RECEPTION',
        actorUserId: world.adminId,
      },
      ctx,
    );

    const [row] = await world.db
      .select({ hash: users.passwordHash })
      .from(users)
      .where(eq(users.id, account.userId));
    expect(await verifyPassword('a-long-enough-password', row?.hash ?? '')).toBe(true);

    const actor = await loadActor(world.db, account.userId, world.eventId);
    expect(actor?.can('card.write', { eventId: world.eventId })).toBe(true);
    expect(actor?.can('pos.operate', { eventId: world.eventId })).toBe(false);
  });

  it('refuses a permission that mints or hands out authority', async () => {
    await expect(
      createRole(
        world.db,
        { key: 'SNEAKY', name: 'Sneaky', permissions: ['pos.operate', 'wallet.topup'] },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'permission_not_grantable' });

    await expect(
      createRole(world.db, { key: 'SNEAKY2', name: 'Sneaky', permissions: ['role.manage'] }, ctx),
    ).rejects.toMatchObject({ code: 'permission_not_grantable' });

    expect(await roleByKey('SNEAKY')).toBeUndefined();
  });

  it('lets a role keep a blocked permission it already holds', async () => {
    // ADMIN holds wallet.topup by catalogue default. Editing the role for an
    // unrelated reason must not quietly strip it.
    const admin = await roleByKey('ADMIN');
    expect(admin?.permissions).toContain('wallet.topup');

    const { permissions } = await setRolePermissions(
      world.db,
      { roleId: admin!.id, permissions: ['wallet.topup', 'report.read'] },
      ctx,
    );
    expect(permissions).toEqual(['report.read', 'wallet.topup']);
  });

  it('will not let super admin lose the ability to manage roles', async () => {
    const superAdmin = await roleByKey('SUPER_ADMIN');
    await expect(
      setRolePermissions(world.db, { roleId: superAdmin!.id, permissions: ['report.read'] }, ctx),
    ).rejects.toMatchObject({ code: 'super_admin_locked' });
  });

  it('refuses to delete a role somebody still holds, and a shipped one ever', async () => {
    await createRole(world.db, { key: 'TEMP', name: 'Temp', permissions: ['card.read'] }, ctx);
    const temp = await roleByKey('TEMP');

    await createStaffAccount(
      world.db,
      {
        eventId: world.eventId,
        displayName: 'Holder',
        email: 'holder@test.local',
        password: 'a-long-enough-password',
        roleKey: 'TEMP',
        actorUserId: world.adminId,
      },
      ctx,
    );

    await expect(deleteRole(world.db, temp!.id, ctx)).rejects.toMatchObject({
      code: 'role_still_held',
    });

    const cashier = await roleByKey('CASHIER');
    await expect(deleteRole(world.db, cashier!.id, ctx)).rejects.toMatchObject({
      code: 'role_is_system',
    });
  });

  it('blocks the danger set in the catalogue the editor renders', () => {
    const catalogue = permissionCatalogue();
    const blocked = catalogue.filter((entry) => !entry.grantable).map((entry) => entry.key);
    expect(blocked).toContain('wallet.topup');
    expect(blocked).toContain('role.manage');
    expect(catalogue.find((entry) => entry.key === 'pos.operate')?.grantable).toBe(true);
  });
});

describe('surviving the catalogue sync', () => {
  it('keeps a custom role and a hand-edited one across a sync', async () => {
    await createRole(world.db, { key: 'RECEPTION', name: 'Reception', permissions: ['card.read'] }, ctx);
    const cashier = await roleByKey('CASHIER');
    await setRolePermissions(
      world.db,
      { roleId: cashier!.id, permissions: ['pos.operate', 'card.resolve'] },
      ctx,
    );

    // What a deploy, a reset or the test harness itself would do.
    await syncRolesAndPermissions(world.db);

    expect(await roleByKey('RECEPTION')).toBeDefined();
    const after = await roleByKey('CASHIER');
    expect(after?.customised).toBe(true);
    expect(after?.permissions).toEqual(['card.resolve', 'pos.operate']);
  });

  it('still overwrites a role nobody has touched', async () => {
    const cashier = await roleByKey('CASHIER');
    expect(cashier?.customised).toBe(false);

    await world.db.delete((await import('../lib/db/schema')).rolePermissions).where(
      eq((await import('../lib/db/schema')).rolePermissions.roleId, cashier!.id),
    );
    await syncRolesAndPermissions(world.db);

    expect((await roleByKey('CASHIER'))?.permissions).toContain('pos.operate');
  });

  it('hands an edited role back to the catalogue on reset', async () => {
    const cashier = await roleByKey('CASHIER');
    await setRolePermissions(world.db, { roleId: cashier!.id, permissions: ['card.read'] }, ctx);
    expect((await roleByKey('CASHIER'))?.customised).toBe(true);

    await resetRoleToDefaults(world.db, cashier!.id, ctx);

    const after = await roleByKey('CASHIER');
    expect(after?.customised).toBe(false);
    expect(after?.permissions).toContain('pos.operate');
    expect(after?.permissions).toContain('wallet.topup.pos');
  });
});

describe('staff accounts', () => {
  it('refuses a duplicate email and a super admin creation', async () => {
    await createStaffAccount(
      world.db,
      {
        eventId: world.eventId,
        displayName: 'One',
        email: 'dup@test.local',
        password: 'a-long-enough-password',
        roleKey: 'CASHIER',
        actorUserId: world.adminId,
      },
      ctx,
    );

    await expect(
      createStaffAccount(
        world.db,
        {
          eventId: world.eventId,
          displayName: 'Two',
          email: 'dup@test.local',
          password: 'a-long-enough-password',
          roleKey: 'CASHIER',
          actorUserId: world.adminId,
        },
        ctx,
      ),
    ).rejects.toThrow(/already uses that email/);

    await expect(
      createStaffAccount(
        world.db,
        {
          eventId: world.eventId,
          displayName: 'Sneaky',
          email: 'sneaky@test.local',
          password: 'a-long-enough-password',
          roleKey: 'SUPER_ADMIN',
          actorUserId: world.adminId,
        },
        ctx,
      ),
    ).rejects.toThrow(/not made from this screen/);
  });

  it('moves an account between roles and cuts its sessions', async () => {
    const account = await createStaffAccount(
      world.db,
      {
        eventId: world.eventId,
        displayName: 'Mover',
        email: 'mover@test.local',
        password: 'a-long-enough-password',
        roleKey: 'CASHIER',
        actorUserId: world.adminId,
      },
      ctx,
    );

    await setStaffRole(
      world.db,
      {
        eventId: world.eventId,
        userId: account.userId,
        roleKey: 'ADMIN',
        actorUserId: world.adminId,
      },
      ctx,
    );

    const actor = await loadActor(world.db, account.userId, world.eventId);
    expect(actor?.can('report.read', { eventId: world.eventId })).toBe(true);
    expect(actor?.roleKeys).toEqual(['ADMIN']);
  });

  it('soft deletes a staff login and frees its email', async () => {
    const account = await createStaffAccount(
      world.db,
      {
        eventId: world.eventId,
        displayName: 'Leaver',
        email: 'leaver@test.local',
        password: 'a-long-enough-password',
        roleKey: 'CASHIER',
        actorUserId: world.adminId,
      },
      ctx,
    );

    await deleteStaffAccount(
      world.db,
      { userId: account.userId, actorUserId: world.adminId },
      ctx,
    );

    const [row] = await world.db
      .select({ deletedAt: users.deletedAt, email: users.email, hash: users.passwordHash })
      .from(users)
      .where(eq(users.id, account.userId));
    expect(row?.deletedAt).not.toBeNull();
    expect(row?.email).toBeNull();
    expect(row?.hash).toBeNull();

    // The address is reusable now, which is the point of clearing it.
    await expect(
      createStaffAccount(
        world.db,
        {
          eventId: world.eventId,
          displayName: 'Replacement',
          email: 'leaver@test.local',
          password: 'a-long-enough-password',
          roleKey: 'CASHIER',
          actorUserId: world.adminId,
        },
        ctx,
      ),
    ).resolves.toBeDefined();
  });

  it('will not delete an account that is also a participant', async () => {
    await expect(
      deleteStaffAccount(
        world.db,
        { userId: world.participantId, actorUserId: world.adminId },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'account_is_participant' });
  });
});

describe('the console boundary', () => {
  it('admits staff and custom roles but never a plain participant', async () => {
    await createRole(
      world.db,
      { key: 'DOOR', name: 'Door', permissions: ['card.write'] },
      ctx,
    );
    const door = await createStaffAccount(
      world.db,
      {
        eventId: world.eventId,
        displayName: 'Door Person',
        email: 'door@test.local',
        password: 'a-long-enough-password',
        roleKey: 'DOOR',
        actorUserId: world.adminId,
      },
      ctx,
    );

    const [admin, cashier, participant, custom] = await Promise.all([
      loadActor(world.db, world.adminId, world.eventId),
      loadActor(world.db, world.cashierId, world.eventId),
      loadActor(world.db, world.participantId, world.eventId),
      loadActor(world.db, door.userId, world.eventId),
    ]);

    expect(isStaff(admin!, world.eventId)).toBe(true);
    expect(isStaff(cashier!, world.eventId)).toBe(true);
    expect(isStaff(custom!, world.eventId)).toBe(true);
    // The regression this guards: an attendee holds reward.read and
    // leaderboard.read, so "can see any nav link" would have let them in.
    expect(isStaff(participant!, world.eventId)).toBe(false);
  });

  it('lands each role on something it can actually open', async () => {
    await createRole(world.db, { key: 'DOOR2', name: 'Door', permissions: ['card.write'] }, ctx);
    const door = await createStaffAccount(
      world.db,
      {
        eventId: world.eventId,
        displayName: 'Door Two',
        email: 'door2@test.local',
        password: 'a-long-enough-password',
        roleKey: 'DOOR2',
        actorUserId: world.adminId,
      },
      ctx,
    );

    const [admin, cashier, participant, custom] = await Promise.all([
      loadActor(world.db, world.adminId, world.eventId),
      loadActor(world.db, world.cashierId, world.eventId),
      loadActor(world.db, world.participantId, world.eventId),
      loadActor(world.db, door.userId, world.eventId),
    ]);

    expect(landingPathFor(admin!, world.eventId, false)).toBe('/admin');
    expect(landingPathFor(cashier!, world.eventId, false)).toBe('/pos');
    expect(landingPathFor(custom!, world.eventId, false)).toBe('/admin/enrol');
    expect(landingPathFor(participant!, world.eventId, false)).toBe('/me');
  });

  it('shows a custom role only the links it can use', async () => {
    await createRole(
      world.db,
      { key: 'DESK', name: 'Desk', permissions: ['card.write', 'participant.read.any'] },
      ctx,
    );
    const desk = await createStaffAccount(
      world.db,
      {
        eventId: world.eventId,
        displayName: 'Desk',
        email: 'desk@test.local',
        password: 'a-long-enough-password',
        roleKey: 'DESK',
        actorUserId: world.adminId,
      },
      ctx,
    );
    const actor = await loadActor(world.db, desk.userId, world.eventId);

    expect(visibleNavFor(actor!, world.eventId, false).map((item) => item.href)).toEqual([
      '/admin/enrol',
      '/admin/participants',
    ]);
  });
});
