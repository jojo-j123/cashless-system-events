import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../lib/db/client';
import {
  balanceOf,
  buildWorld,
  countFulfilled,
  fund,
  inParallel,
  prepareDatabase,
  rejectionCodes,
  setSettings,
  type TestWorld,
} from './helpers';
import { adjustWallet, allocateToTeam, topUpUser, transferPoints } from '../lib/services/wallet';
import { verifyLedgerIntegrity } from '../lib/services/ledger';
import { checkout } from '../lib/services/purchases';

let world: TestWorld;
const ctx = { requestId: 'test' };

beforeEach(async () => {
  const db = await prepareDatabase();
  world = await buildWorld(db);
});

afterAll(async () => {
  await closeDb();
});

describe('top-up', () => {
  it('credits the wallet and leaves the ledger balanced', async () => {
    const { result } = await topUpUser(
      world.db,
      {
        eventId: world.eventId,
        userId: world.participantId,
        amountPoints: 500,
        reason: 'Completed Challenge',
        createdBy: world.financeId,
      },
      'topup-1',
      ctx,
    );

    expect(result.amountPoints).toBe(500);
    expect(result.recipients[0]?.balanceBefore).toBe(0);
    expect(result.recipients[0]?.balanceAfter).toBe(500);
    expect(await balanceOf(world, world.participantId)).toBe(500);

    const integrity = await verifyLedgerIntegrity(world.db, world.eventId);
    expect(integrity.balanced).toBe(true);
    expect(integrity.eventSum).toBe(0);
  });

  it('returns the original result when the same idempotency key is replayed', async () => {
    const first = await topUpUser(
      world.db,
      {
        eventId: world.eventId,
        userId: world.participantId,
        amountPoints: 500,
        reason: 'Welcome points',
        createdBy: world.financeId,
      },
      'topup-replay',
      ctx,
    );
    const second = await topUpUser(
      world.db,
      {
        eventId: world.eventId,
        userId: world.participantId,
        amountPoints: 500,
        reason: 'Welcome points',
        createdBy: world.financeId,
      },
      'topup-replay',
      ctx,
    );

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.result.topupRef).toBe(first.result.topupRef);
    // The critical assertion: the balance moved once, not twice.
    expect(await balanceOf(world, world.participantId)).toBe(500);
  });

  it('rejects reuse of a key with a different body', async () => {
    await topUpUser(
      world.db,
      {
        eventId: world.eventId,
        userId: world.participantId,
        amountPoints: 500,
        reason: 'Welcome points',
        createdBy: world.financeId,
      },
      'topup-conflict',
      ctx,
    );

    await expect(
      topUpUser(
        world.db,
        {
          eventId: world.eventId,
          userId: world.participantId,
          amountPoints: 5_000,
          reason: 'Welcome points',
          createdBy: world.financeId,
        },
        'topup-conflict',
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'idempotency_key_reused' });

    expect(await balanceOf(world, world.participantId)).toBe(500);
  });

  it('refuses an amount above the single top-up limit', async () => {
    await setSettings(world, { maxSingleTopUp: 1_000 });
    await expect(
      topUpUser(
        world.db,
        {
          eventId: world.eventId,
          userId: world.participantId,
          amountPoints: 1_001,
          reason: 'Too much',
          createdBy: world.financeId,
        },
        'topup-over-limit',
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'limit_exceeded' });
  });

  it('refuses to take a wallet above the maximum balance', async () => {
    await setSettings(world, { maxWalletBalance: 1_000, maxSingleTopUp: 100_000 });
    await fund(world, world.participantId, 900);

    await expect(
      topUpUser(
        world.db,
        {
          eventId: world.eventId,
          userId: world.participantId,
          amountPoints: 200,
          reason: 'Overflow',
          createdBy: world.financeId,
        },
        'topup-overflow',
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'limit_exceeded' });

    expect(await balanceOf(world, world.participantId)).toBe(900);
  });

  it('parks a large top-up as an approval request instead of issuing points', async () => {
    await setSettings(world, { approvalThresholdTopUp: 1_000 });

    await expect(
      topUpUser(
        world.db,
        {
          eventId: world.eventId,
          userId: world.participantId,
          amountPoints: 5_000,
          reason: 'Large grant',
          createdBy: world.financeId,
        },
        'topup-approval',
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'approval_required' });

    expect(await balanceOf(world, world.participantId)).toBe(0);
  });
});

describe('manual adjustment', () => {
  it('credits and debits, recording before and after', async () => {
    await fund(world, world.participantId, 1_000);

    const credit = await adjustWallet(
      world.db,
      {
        eventId: world.eventId,
        userId: world.participantId,
        amountPoints: 500,
        reason: 'Event compensation',
        createdBy: world.financeId,
      },
      'adjust-up',
      ctx,
    );
    expect(credit.balanceBefore).toBe(1_000);
    expect(credit.balanceAfter).toBe(1_500);

    const debit = await adjustWallet(
      world.db,
      {
        eventId: world.eventId,
        userId: world.participantId,
        amountPoints: -300,
        reason: 'Correcting a duplicate award',
        createdBy: world.financeId,
      },
      'adjust-down',
      ctx,
    );
    expect(debit.balanceAfter).toBe(1_200);

    expect((await verifyLedgerIntegrity(world.db, world.eventId)).balanced).toBe(true);
  });

  it('cannot push a wallet negative', async () => {
    await fund(world, world.participantId, 100);

    await expect(
      adjustWallet(
        world.db,
        {
          eventId: world.eventId,
          userId: world.participantId,
          amountPoints: -500,
          reason: 'Attempted overdraw',
          createdBy: world.financeId,
        },
        'adjust-negative',
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'insufficient_points' });

    expect(await balanceOf(world, world.participantId)).toBe(100);
  });

  it('requires a reason', async () => {
    await expect(
      adjustWallet(
        world.db,
        {
          eventId: world.eventId,
          userId: world.participantId,
          amountPoints: 100,
          reason: 'x',
          createdBy: world.financeId,
        },
        'adjust-no-reason',
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
});

describe('team allocation', () => {
  it('TEAM_SCORE does not create spendable points', async () => {
    await allocateToTeam(
      world.db,
      {
        eventId: world.eventId,
        teamId: world.teamId,
        amountPoints: 10_000,
        mode: 'TEAM_SCORE',
        reason: 'Challenge win',
        createdBy: world.financeId,
      },
      'alloc-score',
      ctx,
    );

    // The competition score moved; nobody can spend a single extra point.
    expect(await balanceOf(world, world.participantId)).toBe(0);
    expect(await balanceOf(world, world.otherParticipantId)).toBe(0);
    expect((await verifyLedgerIntegrity(world.db, world.eventId)).balanced).toBe(true);
  });

  it('SPLIT_EQUALLY_TO_MEMBERS divides across members', async () => {
    await allocateToTeam(
      world.db,
      {
        eventId: world.eventId,
        teamId: world.teamId,
        amountPoints: 1_000,
        mode: 'SPLIT_EQUALLY_TO_MEMBERS',
        reason: 'Split bonus',
        createdBy: world.financeId,
      },
      'alloc-split',
      ctx,
    );

    expect(await balanceOf(world, world.participantId)).toBe(500);
    expect(await balanceOf(world, world.otherParticipantId)).toBe(500);
  });

  it('EACH_MEMBER_FULL_AMOUNT gives every member the full amount', async () => {
    await allocateToTeam(
      world.db,
      {
        eventId: world.eventId,
        teamId: world.teamId,
        amountPoints: 300,
        mode: 'EACH_MEMBER_FULL_AMOUNT',
        reason: 'Everyone gets 300',
        createdBy: world.financeId,
      },
      'alloc-each',
      ctx,
    );

    expect(await balanceOf(world, world.participantId)).toBe(300);
    expect(await balanceOf(world, world.otherParticipantId)).toBe(300);
    expect((await verifyLedgerIntegrity(world.db, world.eventId)).balanced).toBe(true);
  });
});

describe('transfers', () => {
  it('are disabled by default', async () => {
    await fund(world, world.participantId, 1_000);
    await expect(
      transferPoints(
        world.db,
        {
          eventId: world.eventId,
          fromUserId: world.participantId,
          toUserId: world.otherParticipantId,
          amountPoints: 100,
        },
        'transfer-disabled',
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'feature_disabled' });
  });

  it('move points between wallets when enabled', async () => {
    await setSettings(world, { allowTransfers: true, maxSingleTransfer: 500, dailyTransferLimit: 1_000 });
    await fund(world, world.participantId, 1_000);

    await transferPoints(
      world.db,
      {
        eventId: world.eventId,
        fromUserId: world.participantId,
        toUserId: world.otherParticipantId,
        amountPoints: 400,
      },
      'transfer-ok',
      ctx,
    );

    expect(await balanceOf(world, world.participantId)).toBe(600);
    expect(await balanceOf(world, world.otherParticipantId)).toBe(400);
    expect((await verifyLedgerIntegrity(world.db, world.eventId)).balanced).toBe(true);
  });

  it('enforce the daily limit across several transfers', async () => {
    await setSettings(world, { allowTransfers: true, maxSingleTransfer: 500, dailyTransferLimit: 600 });
    await fund(world, world.participantId, 2_000);

    await transferPoints(
      world.db,
      {
        eventId: world.eventId,
        fromUserId: world.participantId,
        toUserId: world.otherParticipantId,
        amountPoints: 500,
      },
      'transfer-day-1',
      ctx,
    );

    await expect(
      transferPoints(
        world.db,
        {
          eventId: world.eventId,
          fromUserId: world.participantId,
          toUserId: world.otherParticipantId,
          amountPoints: 200,
        },
        'transfer-day-2',
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'limit_exceeded' });
  });
});

describe('concurrency', () => {
  it('prevents double spending when two checkouts race on one wallet', async () => {
    // Exactly enough for one burger, not two.
    await fund(world, world.participantId, 200);

    const attempt = (key: string) => async () =>
      checkout(
        world.db,
        {
          eventId: world.eventId,
          storeId: world.storeId,
          userId: world.participantId,
          cashierUserId: world.cashierId,
          lines: [{ productId: world.burgerId, quantity: 1 }],
        },
        key,
        ctx,
      );

    const results = await inParallel([
      attempt('race-a'),
      attempt('race-b'),
      attempt('race-c'),
      attempt('race-d'),
    ]);

    expect(countFulfilled(results)).toBe(1);
    expect(rejectionCodes(results)).toEqual(
      expect.arrayContaining(['insufficient_points']),
    );
    expect(await balanceOf(world, world.participantId)).toBe(0);
    expect((await verifyLedgerIntegrity(world.db, world.eventId)).balanced).toBe(true);
  });

  it('creates exactly one purchase when the same request is submitted many times at once', async () => {
    await fund(world, world.participantId, 5_000);

    const submit = () => async () =>
      checkout(
        world.db,
        {
          eventId: world.eventId,
          storeId: world.storeId,
          userId: world.participantId,
          cashierUserId: world.cashierId,
          lines: [{ productId: world.burgerId, quantity: 1 }],
        },
        'duplicate-submit',
        ctx,
      );

    const results = await inParallel([submit(), submit(), submit(), submit(), submit()]);

    // Every caller either gets the one receipt or is told to retry; none of
    // them can produce a second charge.
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    expect(await balanceOf(world, world.participantId)).toBe(4_800);
  });

  it('keeps the ledger balanced under a burst of mixed concurrent operations', async () => {
    await fund(world, world.participantId, 10_000);
    await fund(world, world.otherParticipantId, 10_000);

    const operations: (() => Promise<unknown>)[] = [
      ...Array.from({ length: 6 }, (_, index) => () =>
        checkout(
          world.db,
          {
            eventId: world.eventId,
            storeId: world.storeId,
            userId: world.participantId,
            cashierUserId: world.cashierId,
            lines: [{ productId: world.drinkId, quantity: 1 }],
          },
          `burst-buy-${index}`,
          ctx,
        ),
      ),
      ...Array.from({ length: 4 }, (_, index) => () =>
        topUpUser(
          world.db,
          {
            eventId: world.eventId,
            userId: world.otherParticipantId,
            amountPoints: 100,
            reason: 'Burst top-up',
            createdBy: world.financeId,
          },
          `burst-top-${index}`,
          ctx,
        ),
      ),
    ];

    const results = await inParallel(operations);
    expect(countFulfilled(results)).toBe(operations.length);

    const integrity = await verifyLedgerIntegrity(world.db, world.eventId);
    expect(integrity.balanced).toBe(true);
    expect(integrity.driftingAccounts).toBe(0);
  });
});
