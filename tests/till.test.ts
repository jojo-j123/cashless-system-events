import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../lib/db/client';
import { balanceOf, buildWorld, prepareDatabase, setSettings, type TestWorld } from './helpers';
import { topUpAtTill } from '../lib/services/wallet';
import { checkout } from '../lib/services/purchases';
import { verifyLedgerIntegrity } from '../lib/services/ledger';
import { loadActor } from '../lib/authz/actor';

let world: TestWorld;
const ctx = { requestId: 'test' };

beforeEach(async () => {
  world = await buildWorld(await prepareDatabase(), { posTopUpLimit: 2_000 });
});

afterAll(async () => {
  await closeDb();
});

let keySeed = 0;
const nextKey = (): string => `till-key-${(keySeed += 1)}`;

describe('till top-up', () => {
  it('loads points up to the limit', async () => {
    const { result } = await topUpAtTill(
      world.db,
      {
        eventId: world.eventId,
        userId: world.participantId,
        amountPoints: 2_000,
        createdBy: world.cashierId,
      },
      nextKey(),
      ctx,
    );

    expect(result.recipients[0]?.balanceAfter).toBe(2_000);
    expect(await balanceOf(world, world.participantId)).toBe(2_000);
  });

  it('refuses an amount above the till limit', async () => {
    await expect(
      topUpAtTill(
        world.db,
        {
          eventId: world.eventId,
          userId: world.participantId,
          amountPoints: 2_001,
          createdBy: world.cashierId,
        },
        nextKey(),
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'limit_exceeded' });

    expect(await balanceOf(world, world.participantId)).toBe(0);
  });

  it('refuses entirely when the till limit is zero', async () => {
    await setSettings(world, { posTopUpLimit: 0 });

    await expect(
      topUpAtTill(
        world.db,
        {
          eventId: world.eventId,
          userId: world.participantId,
          amountPoints: 100,
          createdBy: world.cashierId,
        },
        nextKey(),
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'feature_disabled' });
  });

  it('keeps the ledger balanced through a till top-up and the purchase it funds', async () => {
    await topUpAtTill(
      world.db,
      {
        eventId: world.eventId,
        userId: world.participantId,
        amountPoints: 500,
        createdBy: world.cashierId,
      },
      nextKey(),
      ctx,
    );

    const { receipt } = await checkout(
      world.db,
      {
        eventId: world.eventId,
        storeId: world.storeId,
        userId: world.participantId,
        cardId: world.cardId,
        cashierUserId: world.cashierId,
        lines: [{ productId: world.burgerId, quantity: 2 }],
      },
      nextKey(),
      ctx,
    );

    expect(receipt.totalPoints).toBe(400);
    expect(receipt.balanceAfter).toBe(100);

    const integrity = await verifyLedgerIntegrity(world.db, world.eventId);
    expect(integrity.balanced).toBe(true);
  });

  it('is reachable by a cashier but not by a participant', async () => {
    const cashier = await loadActor(world.db, world.cashierId, world.eventId);
    const participant = await loadActor(world.db, world.participantId, world.eventId);

    // A cashier's grants are scoped to the store they work, so the till
    // permission only answers true for that store — the same shape as
    // pos.operate, and the reason the route scopes on the store in the body.
    const atStore = { eventId: world.eventId, storeId: world.storeId };
    expect(cashier?.can('wallet.topup.pos', atStore)).toBe(true);
    expect(cashier?.can('wallet.topup.pos', { eventId: world.eventId, storeId: world.otherStoreId })).toBe(
      false,
    );
    expect(participant?.can('wallet.topup.pos', atStore)).toBe(false);

    // The wider counter permission stays off the till: a cashier still cannot
    // allocate to a team or issue an uncapped top-up.
    expect(cashier?.can('wallet.topup', atStore)).toBe(false);
  });
});

describe('store-scoped grants and where a role lands', () => {
  /**
   * The trap this guards is that `can(permission, { eventId })` reads as "may
   * they do this in this event" but means "may they do this with no store",
   * and a cashier's every grant carries one. The root route used to decide a
   * cashier's landing page that way and sent the entire till staff to the
   * participant dashboard.
   */
  it('answers false for a cashier when the scope names no store', async () => {
    const cashier = await loadActor(world.db, world.cashierId, world.eventId);

    expect(cashier?.can('pos.operate', { eventId: world.eventId })).toBe(false);
    expect(cashier?.can('pos.operate', { eventId: world.eventId, storeId: world.storeId })).toBe(
      true,
    );
    // Which is why routing asks the question this way instead.
    expect(cashier?.canAnywhere('pos.operate', world.eventId)).toBe(true);
  });

  it('keeps an admin able to work any till', async () => {
    const admin = await loadActor(world.db, world.adminId, world.eventId);

    expect(admin?.canAnywhere('pos.operate', world.eventId)).toBe(true);
    expect(admin?.can('pos.operate', { eventId: world.eventId, storeId: world.otherStoreId })).toBe(
      true,
    );
    // And so to see the console link back out of the till.
    expect(admin?.canAnywhere('report.read', world.eventId)).toBe(true);
    const cashier = await loadActor(world.db, world.cashierId, world.eventId);
    expect(cashier?.canAnywhere('report.read', world.eventId)).toBe(false);
  });
});
