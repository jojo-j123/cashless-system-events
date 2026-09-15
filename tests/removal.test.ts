import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { closeDb } from '../lib/db/client';
import { balanceOf, buildWorld, fund, prepareDatabase, type TestWorld } from './helpers';
import {
  executeCardRemoval,
  executeParticipantRemoval,
  planCardRemoval,
  planParticipantRemoval,
} from '../lib/services/removal';
import { assignCard, createCards } from '../lib/services/cards';
import { createParticipant } from '../lib/services/provisioning';
import { verifyLedgerIntegrity } from '../lib/services/ledger';
import { accounts, eventParticipants, nfcCards, users } from '../lib/db/schema';

let world: TestWorld;
const ctx = { requestId: 'test' };

beforeEach(async () => {
  world = await buildWorld(await prepareDatabase(), { tapCooldownMs: 0 });
});

afterAll(async () => {
  await closeDb();
});

let keySeed = 0;
const nextKey = (): string => `removal-key-${(keySeed += 1)}`;

async function freshParticipant(name: string): Promise<string> {
  const created = await createParticipant(
    world.db,
    { eventId: world.eventId, displayName: name },
    { actorUserId: world.adminId, requestId: 'test' },
  );
  return created.userId;
}

async function forfeitureBalance(): Promise<number> {
  const [row] = await world.db
    .select({ balance: accounts.balance })
    .from(accounts)
    .where(
      and(eq(accounts.eventId, world.eventId), eq(accounts.type, 'SYSTEM_FORFEITURE')),
    );
  return row?.balance ?? 0;
}

describe('bulk card removal', () => {
  it('deletes cards that were never used', async () => {
    const issued = await createCards(
      world.db,
      { eventId: world.eventId, count: 3, batchLabel: 'Test box' },
      ctx,
    );
    const ids = issued.map((card) => card.cardId);

    const plan = await planCardRemoval(world.db, { eventId: world.eventId, cardIds: ids });
    expect(plan.deleteCount).toBe(3);
    expect(plan.deactivateCount).toBe(0);

    await executeCardRemoval(
      world.db,
      { eventId: world.eventId, cardIds: ids, reason: 'Test batch cleanup', actorUserId: world.adminId },
      nextKey(),
      ctx,
    );

    const remaining = await world.db
      .select({ id: nfcCards.id })
      .from(nfcCards)
      .where(eq(nfcCards.eventId, world.eventId));
    expect(remaining.map((row) => row.id)).not.toContain(ids[0]);
  });

  it('deactivates a card that has been used rather than deleting it', async () => {
    await world.db.execute(sql`
      insert into card_taps (event_id, card_id, credential_kind, credential_fingerprint, outcome)
      values (${world.eventId}, ${world.cardId}, 'TOKEN', 'fingerprint-test', 'RESOLVED')
    `);

    const plan = await planCardRemoval(world.db, {
      eventId: world.eventId,
      cardIds: [world.cardId],
    });
    expect(plan.deactivateCount).toBe(1);
    expect(plan.deleteCount).toBe(0);

    await executeCardRemoval(
      world.db,
      {
        eventId: world.eventId,
        cardIds: [world.cardId],
        reason: 'Card retired after the event',
        actorUserId: world.adminId,
      },
      nextKey(),
      ctx,
    );

    const [card] = await world.db
      .select({ status: nfcCards.status, assignedUserId: nfcCards.assignedUserId })
      .from(nfcCards)
      .where(eq(nfcCards.id, world.cardId));
    expect(card?.status).toBe('DEACTIVATED');
    expect(card?.assignedUserId).toBeNull();
  });

  it('deactivates an assigned card even when it was never tapped', async () => {
    // card_events is append-only, so assignment alone makes a card undeletable.
    const issued = await createCards(world.db, { eventId: world.eventId, count: 1 }, ctx);
    const cardId = issued[0]!.cardId;
    const userId = await freshParticipant('Holds A Card');
    await assignCard(world.db, { eventId: world.eventId, cardId, userId }, ctx);

    const plan = await planCardRemoval(world.db, { eventId: world.eventId, cardIds: [cardId] });
    expect(plan.deleteCount).toBe(0);
    expect(plan.deactivateCount).toBe(1);

    await executeCardRemoval(
      world.db,
      {
        eventId: world.eventId,
        cardIds: [cardId],
        reason: 'Assigned card retired',
        actorUserId: world.adminId,
      },
      nextKey(),
      ctx,
    );

    const [card] = await world.db
      .select({ status: nfcCards.status })
      .from(nfcCards)
      .where(eq(nfcCards.id, cardId));
    expect(card?.status).toBe('DEACTIVATED');
  });

  it('skips a card that is already deactivated', async () => {
    const issued = await createCards(world.db, { eventId: world.eventId, count: 1 }, ctx);
    const cardId = issued[0]!.cardId;
    await world.db
      .update(nfcCards)
      .set({ status: 'DEACTIVATED' })
      .where(eq(nfcCards.id, cardId));

    const plan = await planCardRemoval(world.db, { eventId: world.eventId, cardIds: [cardId] });
    expect(plan.blockedCount).toBe(1);
    expect(plan.rows[0]?.reason).toContain('Already deactivated');
  });
});

describe('bulk participant removal', () => {
  it('deletes a participant who has no transactions', async () => {
    const userId = await freshParticipant('Never Funded');

    const plan = await planParticipantRemoval(world.db, {
      eventId: world.eventId,
      userIds: [userId],
      actorUserId: world.adminId,
    });
    expect(plan.deleteCount).toBe(1);
    expect(plan.pointsForfeited).toBe(0);

    await executeParticipantRemoval(
      world.db,
      {
        eventId: world.eventId,
        userIds: [userId],
        reason: 'Duplicate row from the morning import',
        actorUserId: world.adminId,
      },
      nextKey(),
      ctx,
    );

    const roster = await world.db
      .select({ userId: eventParticipants.userId })
      .from(eventParticipants)
      .where(
        and(
          eq(eventParticipants.eventId, world.eventId),
          eq(eventParticipants.userId, userId),
        ),
      );
    expect(roster).toHaveLength(0);

    const wallets = await world.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.eventId, world.eventId), eq(accounts.ownerUserId, userId)));
    expect(wallets).toHaveLength(0);
  });

  it('forfeits the balance of a funded participant and keeps the ledger balanced', async () => {
    await fund(world, world.participantId, 750);
    expect(await balanceOf(world, world.participantId)).toBe(750);
    const forfeitureBefore = await forfeitureBalance();

    const plan = await planParticipantRemoval(world.db, {
      eventId: world.eventId,
      userIds: [world.participantId],
      actorUserId: world.adminId,
    });
    expect(plan.deactivateCount).toBe(1);
    expect(plan.pointsForfeited).toBe(750);

    await executeParticipantRemoval(
      world.db,
      {
        eventId: world.eventId,
        userIds: [world.participantId],
        reason: 'Left the event early',
        actorUserId: world.adminId,
      },
      nextKey(),
      ctx,
    );

    expect(await balanceOf(world, world.participantId)).toBe(0);
    expect(await forfeitureBalance()).toBe(forfeitureBefore + 750);

    const integrity = await verifyLedgerIntegrity(world.db, world.eventId);
    expect(integrity.balanced).toBe(true);
  });

  it('closes the wallets of a removed participant instead of deleting them', async () => {
    await fund(world, world.participantId, 200);
    await executeParticipantRemoval(
      world.db,
      {
        eventId: world.eventId,
        userIds: [world.participantId],
        reason: 'Left the event early',
        actorUserId: world.adminId,
      },
      nextKey(),
      ctx,
    );

    const wallets = await world.db
      .select({ status: accounts.status })
      .from(accounts)
      .where(
        and(eq(accounts.eventId, world.eventId), eq(accounts.ownerUserId, world.participantId)),
      );
    expect(wallets.length).toBeGreaterThan(0);
    expect(wallets.every((row) => row.status === 'CLOSED')).toBe(true);
  });

  it('refuses to remove staff or the actor themselves', async () => {
    const plan = await planParticipantRemoval(world.db, {
      eventId: world.eventId,
      userIds: [world.adminId, world.cashierId],
      actorUserId: world.adminId,
    });

    expect(plan.blockedCount).toBe(2);
    expect(plan.deleteCount + plan.deactivateCount).toBe(0);

    await executeParticipantRemoval(
      world.db,
      {
        eventId: world.eventId,
        userIds: [world.adminId, world.cashierId],
        reason: 'Attempted staff removal',
        actorUserId: world.adminId,
      },
      nextKey(),
      ctx,
    );

    const roster = await world.db
      .select({ userId: eventParticipants.userId })
      .from(eventParticipants)
      .where(eq(eventParticipants.eventId, world.eventId));
    const ids = roster.map((row) => row.userId);
    expect(ids).toContain(world.adminId);
    expect(ids).toContain(world.cashierId);
  });

  it('does not forfeit twice when the same request is replayed', async () => {
    await fund(world, world.participantId, 400);
    const key = nextKey();
    const input = {
      eventId: world.eventId,
      userIds: [world.participantId],
      reason: 'Left the event early',
      actorUserId: world.adminId,
    };

    const first = await executeParticipantRemoval(world.db, input, key, ctx);
    const second = await executeParticipantRemoval(world.db, input, key, ctx);

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(await forfeitureBalance()).toBe(400);

    const integrity = await verifyLedgerIntegrity(world.db, world.eventId);
    expect(integrity.balanced).toBe(true);
  });

  it('retires a login that is left in no event at all', async () => {
    const userId = await freshParticipant('Only Here');

    await executeParticipantRemoval(
      world.db,
      {
        eventId: world.eventId,
        userIds: [userId],
        reason: 'Removed from the only event they were in',
        actorUserId: world.adminId,
      },
      nextKey(),
      ctx,
    );

    const [user] = await world.db
      .select({ deletedAt: users.deletedAt, status: users.status })
      .from(users)
      .where(eq(users.id, userId));
    expect(user?.deletedAt).not.toBeNull();
    expect(user?.status).toBe('DEACTIVATED');
  });

  it('plans without writing anything', async () => {
    await fund(world, world.participantId, 300);

    await planParticipantRemoval(world.db, {
      eventId: world.eventId,
      userIds: [world.participantId],
      actorUserId: world.adminId,
    });

    expect(await balanceOf(world, world.participantId)).toBe(300);
    const roster = await world.db
      .select({ userId: eventParticipants.userId })
      .from(eventParticipants)
      .where(
        and(
          eq(eventParticipants.eventId, world.eventId),
          eq(eventParticipants.userId, world.participantId),
        ),
      );
    expect(roster).toHaveLength(1);
  });
});
