import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../lib/db/client';
import { buildWorld, prepareDatabase, type TestWorld } from './helpers';
import { loadActor, type Actor } from '../lib/authz/actor';
import {
  ALL_PERMISSIONS,
  ROLE_KEYS,
  ROLE_PERMISSIONS,
  STAFF_ROLE_KEYS,
  type Permission,
} from '../lib/authz/permissions';
import { hashPassword, hashPin, needsRehash, verifyPassword, verifyPin } from '../lib/auth/password';

let world: TestWorld;

beforeEach(async () => {
  const db = await prepareDatabase();
  world = await buildWorld(db);
});

afterAll(async () => {
  await closeDb();
});

async function actorFor(userId: string): Promise<Actor> {
  const actor = await loadActor(world.db, userId, world.eventId);
  if (!actor) throw new Error('actor not found');
  return actor;
}

describe('cashier boundaries', () => {
  /**
   * The single most important authorisation property in the system: someone
   * who can take payments must not be able to create points.
   */
  const FORBIDDEN_FOR_CASHIER: Permission[] = [
    'wallet.topup',
    'wallet.adjust',
    'product.write',
    'role.manage',
    'settings.write',
    'event.write',
    'audit.read',
    'ledger.read',
    'inventory.adjust',
    'store.write',
    'team.allocate',
    'approval.decide',
    'challenge.award',
    'terminal.write',
  ];

  it.each(FORBIDDEN_FOR_CASHIER)('a cashier cannot %s', async (permission) => {
    const cashier = await actorFor(world.cashierId);
    expect(cashier.can(permission, { eventId: world.eventId, storeId: world.storeId })).toBe(false);
    expect(() => cashier.require(permission, { eventId: world.eventId })).toThrow();
  });

  it('a cashier can run a checkout at their own store', async () => {
    const cashier = await actorFor(world.cashierId);
    expect(cashier.can('pos.operate', { eventId: world.eventId, storeId: world.storeId })).toBe(
      true,
    );
    expect(cashier.can('card.resolve', { eventId: world.eventId, storeId: world.storeId })).toBe(
      true,
    );
  });

  it('a cashier has no authority at a store they are not assigned to', async () => {
    const cashier = await actorFor(world.cashierId);
    // The grant is scoped to one store, so authority does not travel.
    expect(cashier.can('pos.operate', { eventId: world.eventId, storeId: world.otherStoreId })).toBe(
      false,
    );
  });

  it('storesFor reports only the stores a cashier is scoped to', async () => {
    const cashier = await actorFor(world.cashierId);
    expect(cashier.storesFor('pos.operate', world.eventId)).toEqual([world.storeId]);
  });

  it('a store-scoped cashier can still reach the till page', async () => {
    const cashier = await actorFor(world.cashierId);

    // The regression this guards: page gates asked `can(permission, {eventId})`
    // with no store in hand. A grant scoped to a store matches neither branch of
    // that check, so the cashier the till exists for was redirected away from it.
    expect(cashier.can('pos.operate', { eventId: world.eventId })).toBe(false);
    expect(cashier.canAnywhere('pos.operate', world.eventId)).toBe(true);
  });

  it('reaching the page is still not authority over a store', async () => {
    const cashier = await actorFor(world.cashierId);

    // canAnywhere opens the door; it must not open the till at someone else's
    // store. That stays with can(), which every API handler calls per request.
    expect(cashier.canAnywhere('pos.operate', world.eventId)).toBe(true);
    expect(cashier.can('pos.operate', { eventId: world.eventId, storeId: world.otherStoreId })).toBe(
      false,
    );
  });

  it('does not invent authority a participant never had', async () => {
    const participant = await actorFor(world.participantId);
    expect(participant.canAnywhere('pos.operate', world.eventId)).toBe(false);
  });
});

describe('role boundaries', () => {
  it('a participant cannot read another wallet or any admin surface', async () => {
    const participant = await actorFor(world.participantId);
    expect(participant.can('wallet.read.self', { eventId: world.eventId })).toBe(true);
    expect(participant.can('wallet.read.any', { eventId: world.eventId })).toBe(false);
    expect(participant.can('participant.read.any', { eventId: world.eventId })).toBe(false);
    expect(participant.can('pos.operate', { eventId: world.eventId })).toBe(false);
    expect(participant.can('audit.read', { eventId: world.eventId })).toBe(false);
  });

  it('requireSelfOr lets a participant read themselves but not others', async () => {
    const participant = await actorFor(world.participantId);
    expect(() =>
      participant.requireSelfOr(
        world.participantId,
        'wallet.read.self',
        'wallet.read.any',
        { eventId: world.eventId },
      ),
    ).not.toThrow();

    expect(() =>
      participant.requireSelfOr(
        world.otherParticipantId,
        'wallet.read.self',
        'wallet.read.any',
        { eventId: world.eventId },
      ),
    ).toThrow(/permission/i);
  });

  it('money operations belong to an admin, not to a tier below one', async () => {
    // There is no finance role any more: whoever runs the points desk is an
    // admin, so they carry product and stock authority too. The line that
    // still holds is the one below — a cashier gets none of it.
    const finance = await actorFor(world.financeId);
    expect(finance.can('wallet.topup', { eventId: world.eventId })).toBe(true);
    expect(finance.can('wallet.adjust', { eventId: world.eventId })).toBe(true);
    expect(finance.can('approval.decide', { eventId: world.eventId })).toBe(true);
    expect(finance.can('role.manage', { eventId: world.eventId })).toBe(false);

    const cashier = await actorFor(world.cashierId);
    expect(cashier.can('wallet.topup', { eventId: world.eventId })).toBe(false);
    expect(cashier.can('wallet.adjust', { eventId: world.eventId })).toBe(false);
    expect(cashier.can('approval.decide', { eventId: world.eventId })).toBe(false);
    expect(cashier.can('product.write', { eventId: world.eventId })).toBe(false);
  });

  it('an admin cannot grant roles — that is reserved for a super admin', async () => {
    const admin = await actorFor(world.adminId);
    expect(admin.can('wallet.topup', { eventId: world.eventId })).toBe(true);
    expect(admin.can('event.write', { eventId: world.eventId })).toBe(true);
    // Separation of duties: an admin cannot quietly promote themselves.
    expect(admin.can('role.manage', { eventId: world.eventId })).toBe(false);
  });

  it('authority does not leak across events', async () => {
    const admin = await actorFor(world.adminId);
    const otherEventId = '00000000-0000-0000-0000-0000000000ff';
    expect(admin.can('wallet.topup', { eventId: world.eventId })).toBe(true);
    expect(admin.can('wallet.topup', { eventId: otherEventId })).toBe(false);
  });
});

describe('permission catalogue', () => {
  it('every role grants only permissions that exist', () => {
    for (const [role, granted] of Object.entries(ROLE_PERMISSIONS)) {
      for (const permission of granted) {
        expect(
          ALL_PERMISSIONS,
          `${role} grants unknown permission ${permission}`,
        ).toContain(permission);
      }
    }
  });

  it('only SUPER_ADMIN can manage roles', () => {
    const holders = Object.entries(ROLE_PERMISSIONS)
      .filter(([, granted]) => granted.includes('role.manage'))
      .map(([role]) => role);
    expect(holders).toEqual(['SUPER_ADMIN']);
  });

  it('only an admin can create points', () => {
    const creators = Object.entries(ROLE_PERMISSIONS)
      .filter(([, granted]) => granted.includes('wallet.topup'))
      .map(([role]) => role)
      .sort();
    expect(creators).toEqual(['ADMIN', 'SUPER_ADMIN']);
  });

  it('a cashier can take money but never create or reprice it', () => {
    const cashier = ROLE_PERMISSIONS.CASHIER;
    expect(cashier).toContain('pos.operate');
    expect(cashier).not.toContain('wallet.topup');
    expect(cashier).not.toContain('wallet.adjust');
    expect(cashier).not.toContain('product.write');
    expect(cashier).not.toContain('inventory.adjust');
  });

  it('offers exactly three staff roles', () => {
    expect([...STAFF_ROLE_KEYS]).toEqual(['SUPER_ADMIN', 'ADMIN', 'CASHIER']);
    // PARTICIPANT is in the catalogue but is not a job anyone is hired into.
    expect(STAFF_ROLE_KEYS).not.toContain('PARTICIPANT');
    expect([...ROLE_KEYS].sort()).toEqual(['ADMIN', 'CASHIER', 'PARTICIPANT', 'SUPER_ADMIN']);
  });
});

describe('credential hashing', () => {
  it('verifies a correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(await verifyPassword('Correct horse battery staple', hash)).toBe(false);
    expect(needsRehash(hash)).toBe(false);
  });

  it('produces a different hash every time (random salt)', async () => {
    const a = await hashPassword('same password here');
    const b = await hashPassword('same password here');
    expect(a).not.toBe(b);
    expect(await verifyPassword('same password here', a)).toBe(true);
    expect(await verifyPassword('same password here', b)).toBe(true);
  });

  it('rejects a malformed or poisoned stored hash instead of throwing', async () => {
    expect(await verifyPassword('anything', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('anything', '')).toBe(false);
    // A hash claiming absurd parameters must not become a CPU denial of service.
    expect(await verifyPassword('anything', 'scrypt$99999999$999$1$c2FsdA==$aGFzaA==')).toBe(false);
  });

  it('flags legacy parameters for rehashing', () => {
    expect(needsRehash('scrypt$1024$8$1$c2FsdA==$aGFzaA==')).toBe(true);
    expect(needsRehash('bcrypt$whatever')).toBe(true);
  });

  it('accepts a 4-digit PIN, which the password policy would reject', async () => {
    const hash = await hashPin('4821');
    expect(await verifyPin('4821', hash)).toBe(true);
    expect(await verifyPin('1234', hash)).toBe(false);
    await expect(hashPin('12')).rejects.toThrow(/4 to 12 digits/);
    await expect(hashPin('abcd')).rejects.toThrow(/4 to 12 digits/);
  });
});
