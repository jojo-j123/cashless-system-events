import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb } from '../lib/db/client';
import {
  balanceOf,
  buildWorld,
  countFulfilled,
  countRows,
  fund,
  inParallel,
  prepareDatabase,
  stockOf,
  type TestWorld,
} from './helpers';
import {
  cancelRedemption,
  createReward,
  fulfilRedemption,
  listRedemptions,
  listRewards,
  redeemReward,
  updateReward,
} from '../lib/services/rewards';
import { verifyLedgerIntegrity } from '../lib/services/ledger';
import { rewards } from '../lib/db/schema';

let world: TestWorld;

const ctx = { actorUserId: null, requestId: 'test' };

beforeEach(async () => {
  const db = await prepareDatabase();
  // Deliberately a normal event: rewards are not a game feature.
  world = await buildWorld(db);
  await fund(world, world.participantId, 5_000);
});

afterAll(async () => {
  await closeDb();
});

async function makeReward(
  overrides: Partial<Parameters<typeof createReward>[1]> = {},
): Promise<string> {
  const { rewardId } = await createReward(
    world.db,
    {
      eventId: world.eventId,
      name: 'Queue skip',
      costPoints: 200,
      stock: 5,
      ...overrides,
    },
    ctx,
  );
  return rewardId;
}

function redeem(rewardId: string, key: string, userId = world.participantId) {
  return redeemReward(
    world.db,
    { eventId: world.eventId, rewardId, userId, redeemedBy: world.adminId },
    key,
    ctx,
  );
}

async function stockLeft(rewardId: string): Promise<number | null> {
  const [row] = await world.db
    .select({ stock: rewards.stock })
    .from(rewards)
    .where(eq(rewards.id, rewardId));
  return row?.stock ?? null;
}

describe('rewards are not a game feature', () => {
  it('a normal event can create and redeem them', async () => {
    // buildWorld makes a standard event; nothing here turns game mode on.
    const rewardId = await makeReward();
    const before = await balanceOf(world, world.participantId);

    const { result } = await redeem(rewardId, 'normal-event');

    expect(result.costPoints).toBe(200);
    expect(await balanceOf(world, world.participantId)).toBe(before - 200);
    expect((await verifyLedgerIntegrity(world.db, world.eventId)).balanced).toBe(true);
  });
});

describe('authoring rewards', () => {
  it('lists a new reward with nothing redeemed', async () => {
    await makeReward();
    const [reward] = await listRewards(world.db, world.eventId);
    expect(reward?.name).toBe('Queue skip');
    expect(reward?.redeemed).toBe(0);
    expect(reward?.stock).toBe(5);
  });

  it('refuses a negative cost or negative stock', async () => {
    await expect(makeReward({ costPoints: -1 })).rejects.toThrow(/whole number of zero or more/i);
    await expect(makeReward({ stock: -3 })).rejects.toThrow(/zero or more, or blank/i);
  });

  it('an inactive reward cannot be redeemed', async () => {
    const rewardId = await makeReward();
    await updateReward(world.db, { eventId: world.eventId, rewardId, isActive: false }, ctx);
    await expect(redeem(rewardId, 'inactive')).rejects.toThrow(/not available/i);
  });

  it('a reward from another event reads as missing', async () => {
    const rewardId = await makeReward();
    await expect(
      redeemReward(
        world.db,
        {
          eventId: '00000000-0000-0000-0000-0000000000ff',
          rewardId,
          userId: world.participantId,
          redeemedBy: world.adminId,
        },
        'wrong-event',
        ctx,
      ),
    ).rejects.toThrow();
  });
});

describe('redeeming', () => {
  it('takes the points and records a claim awaiting collection', async () => {
    const rewardId = await makeReward();
    const { result } = await redeem(rewardId, 'claim-1');

    expect(await stockLeft(rewardId)).toBe(4);

    const [redemption] = await listRedemptions(world.db, world.eventId);
    expect(redemption?.id).toBe(result.redemptionId);
    expect(redemption?.status).toBe('CLAIMED');
    expect((await verifyLedgerIntegrity(world.db, world.eventId)).balanced).toBe(true);
  });

  it('refuses when the wallet cannot cover it', async () => {
    const rewardId = await makeReward({ costPoints: 999_999 });
    await expect(redeem(rewardId, 'too-dear')).rejects.toThrow();
    // Nothing partial survives: the stock is untouched.
    expect(await stockLeft(rewardId)).toBe(5);
    expect(await countRows(world.db, 'reward_redemptions')).toBe(0);
  });

  it('refuses once the stock is gone', async () => {
    const rewardId = await makeReward({ stock: 1, costPoints: 10 });
    await redeem(rewardId, 'last-one');
    await expect(redeem(rewardId, 'one-too-many')).rejects.toThrow();
    expect(await stockLeft(rewardId)).toBe(0);
  });

  it('unlimited stock stays unlimited', async () => {
    const rewardId = await makeReward({ stock: null, costPoints: 10 });
    await redeem(rewardId, 'unlimited-a');
    await redeem(rewardId, 'unlimited-b');
    await redeem(rewardId, 'unlimited-c');
    expect(await stockLeft(rewardId)).toBeNull();
    expect(await countRows(world.db, 'reward_redemptions')).toBe(3);
  });

  it('replaying one idempotency key does not charge again', async () => {
    const rewardId = await makeReward();
    const before = await balanceOf(world, world.participantId);

    const first = await redeem(rewardId, 'same-key');
    const replay = await redeem(rewardId, 'same-key');

    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.result.redemptionId).toBe(first.result.redemptionId);
    expect(await balanceOf(world, world.participantId)).toBe(before - 200);
    expect(await stockLeft(rewardId)).toBe(4);
  });

  /**
   * The property the conditional UPDATE exists for: one left on the shelf and
   * six people claiming it at the same instant is exactly one redemption.
   */
  it('six simultaneous claims on the last one succeed exactly once', async () => {
    const rewardId = await makeReward({ stock: 1, costPoints: 10 });
    const before = await balanceOf(world, world.participantId);

    const results = await inParallel(
      ['a', 'b', 'c', 'd', 'e', 'f'].map((key) => () => redeem(rewardId, `race-${key}`)),
    );

    expect(countFulfilled(results)).toBe(1);
    expect(await countRows(world.db, 'reward_redemptions')).toBe(1);
    expect(await stockLeft(rewardId)).toBe(0);
    expect(await balanceOf(world, world.participantId)).toBe(before - 10);
    expect((await verifyLedgerIntegrity(world.db, world.eventId)).balanced).toBe(true);
  });

  it('the cost is frozen at redemption time', async () => {
    const rewardId = await makeReward({ costPoints: 200 });
    await redeem(rewardId, 'before-reprice');

    // Repricing a reward next week must not rewrite what somebody paid today.
    await updateReward(world.db, { eventId: world.eventId, rewardId, costPoints: 900 }, ctx);

    const [redemption] = await listRedemptions(world.db, world.eventId);
    expect(redemption?.costPoints).toBe(200);
  });
});

describe('fulfilment', () => {
  it('marks a claim as handed over, and is idempotent', async () => {
    const rewardId = await makeReward();
    const { result } = await redeem(rewardId, 'to-fulfil');

    const fulfil = () =>
      fulfilRedemption(
        world.db,
        {
          eventId: world.eventId,
          redemptionId: result.redemptionId,
          fulfilledBy: world.adminId,
        },
        ctx,
      );

    await fulfil();
    await fulfil();

    const [redemption] = await listRedemptions(world.db, world.eventId);
    expect(redemption?.status).toBe('FULFILLED');
  });

  it('refuses to fulfil something that was cancelled', async () => {
    const rewardId = await makeReward();
    const { result } = await redeem(rewardId, 'to-cancel-then-fulfil');
    await cancelRedemption(
      world.db,
      {
        eventId: world.eventId,
        redemptionId: result.redemptionId,
        reason: 'Claimed by mistake',
        cancelledBy: world.adminId,
      },
      'cancel-key-1',
      ctx,
    );

    await expect(
      fulfilRedemption(
        world.db,
        {
          eventId: world.eventId,
          redemptionId: result.redemptionId,
          fulfilledBy: world.adminId,
        },
        ctx,
      ),
    ).rejects.toThrow(/cancelled/i);
  });
});

describe('cancelling', () => {
  it('returns the points and the stock, and leaves the ledger balanced', async () => {
    const rewardId = await makeReward();
    const before = await balanceOf(world, world.participantId);
    const { result } = await redeem(rewardId, 'to-refund');

    expect(await balanceOf(world, world.participantId)).toBe(before - 200);

    await cancelRedemption(
      world.db,
      {
        eventId: world.eventId,
        redemptionId: result.redemptionId,
        reason: 'Wrong person',
        cancelledBy: world.adminId,
      },
      'cancel-key-2',
      ctx,
    );

    expect(await balanceOf(world, world.participantId)).toBe(before);
    expect(await stockLeft(rewardId)).toBe(5);

    const [redemption] = await listRedemptions(world.db, world.eventId);
    expect(redemption?.status).toBe('CANCELLED');
    expect((await verifyLedgerIntegrity(world.db, world.eventId)).balanced).toBe(true);
  });

  it('cancelling an unlimited reward does not invent a stock number', async () => {
    const rewardId = await makeReward({ stock: null, costPoints: 10 });
    const { result } = await redeem(rewardId, 'unlimited-cancel');
    await cancelRedemption(
      world.db,
      {
        eventId: world.eventId,
        redemptionId: result.redemptionId,
        reason: 'Changed their mind',
        cancelledBy: world.adminId,
      },
      'cancel-key-3',
      ctx,
    );
    expect(await stockLeft(rewardId)).toBeNull();
  });

  it('refuses a second cancellation', async () => {
    const rewardId = await makeReward();
    const { result } = await redeem(rewardId, 'double-cancel');
    const cancel = (key: string) =>
      cancelRedemption(
        world.db,
        {
          eventId: world.eventId,
          redemptionId: result.redemptionId,
          reason: 'Duplicate',
          cancelledBy: world.adminId,
        },
        key,
        ctx,
      );

    await cancel('cancel-a');
    await expect(cancel('cancel-b')).rejects.toThrow(/already cancelled/i);
  });

  it('needs a reason', async () => {
    const rewardId = await makeReward();
    const { result } = await redeem(rewardId, 'no-reason');
    await expect(
      cancelRedemption(
        world.db,
        {
          eventId: world.eventId,
          redemptionId: result.redemptionId,
          reason: 'x',
          cancelledBy: world.adminId,
        },
        'cancel-key-4',
        ctx,
      ),
    ).rejects.toThrow(/reason/i);
  });

  it('a cancelled redemption stops counting as redeemed', async () => {
    const rewardId = await makeReward();
    const { result } = await redeem(rewardId, 'uncount');
    await cancelRedemption(
      world.db,
      {
        eventId: world.eventId,
        redemptionId: result.redemptionId,
        reason: 'Returned',
        cancelledBy: world.adminId,
      },
      'cancel-key-5',
      ctx,
    );

    const [reward] = await listRewards(world.db, world.eventId);
    expect(reward?.redeemed).toBe(0);
  });
});

describe('a reward standing for a real product', () => {
  it('moves real stock, and puts it back when cancelled', async () => {
    const stockBefore = await stockOf(world, world.hoodieId);
    const rewardId = await makeReward({
      name: 'Free hoodie',
      costPoints: 100,
      stock: 3,
      productId: world.hoodieId,
    });

    const { result } = await redeem(rewardId, 'hoodie-claim');
    expect(await stockOf(world, world.hoodieId)).toBe(stockBefore - 1);

    await cancelRedemption(
      world.db,
      {
        eventId: world.eventId,
        redemptionId: result.redemptionId,
        reason: 'Wrong size',
        cancelledBy: world.adminId,
      },
      'hoodie-cancel',
      ctx,
    );

    expect(await stockOf(world, world.hoodieId)).toBe(stockBefore);
    expect((await verifyLedgerIntegrity(world.db, world.eventId)).balanced).toBe(true);
  });

  it('refuses when the product itself has run out', async () => {
    // The fixture stocks exactly one hoodie; take it with a first redemption.
    const rewardId = await makeReward({
      name: 'Free hoodie',
      costPoints: 10,
      stock: 10,
      productId: world.hoodieId,
    });
    await redeem(rewardId, 'hoodie-1');
    expect(await stockOf(world, world.hoodieId)).toBe(0);

    await expect(redeem(rewardId, 'hoodie-2')).rejects.toThrow();
    // The reward's own stock is not quietly consumed by the failed attempt.
    expect(await stockLeft(rewardId)).toBe(9);
    expect(await countRows(world.db, 'reward_redemptions')).toBe(1);
  });
});
