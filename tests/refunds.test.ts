import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb } from '../lib/db/client';
import {
  balanceOf,
  buildWorld,
  countRows,
  fund,
  prepareDatabase,
  setSettings,
  stockOf,
  type TestWorld,
} from './helpers';
import { checkout } from '../lib/services/purchases';
import { getRefundableSummary, refundPurchase } from '../lib/services/refunds';
import { verifyLedgerIntegrity } from '../lib/services/ledger';
import { ledgerEntries, ledgerTransactions, purchases } from '../lib/db/schema';

let world: TestWorld;
const ctx = { requestId: 'test' };

beforeEach(async () => {
  const db = await prepareDatabase();
  world = await buildWorld(db);
  await fund(world, world.participantId, 5_000);
});

afterAll(async () => {
  await closeDb();
});

async function buyBurgerAndDrink(key = 'refund-setup') {
  const { receipt } = await checkout(
    world.db,
    {
      eventId: world.eventId,
      storeId: world.storeId,
      userId: world.participantId,
      cashierUserId: world.cashierId,
      lines: [
        { productId: world.burgerId, quantity: 2 },
        { productId: world.drinkId, quantity: 1 },
      ],
    },
    key,
    ctx,
  );
  return receipt;
}

describe('refunds', () => {
  it('returns the full amount and restocks', async () => {
    const receipt = await buyBurgerAndDrink();
    expect(receipt.totalPoints).toBe(500);
    expect(await balanceOf(world, world.participantId)).toBe(4_500);

    const { refund } = await refundPurchase(
      world.db,
      {
        eventId: world.eventId,
        purchaseId: receipt.purchaseId,
        reason: 'Customer changed their mind',
        requestedBy: world.financeId,
      },
      'refund-full',
      ctx,
    );

    expect(refund.type).toBe('FULL');
    expect(refund.amountPoints).toBe(500);
    expect(refund.balanceAfter).toBe(5_000);
    expect(refund.purchaseStatus).toBe('REFUNDED');
    expect(await balanceOf(world, world.participantId)).toBe(5_000);
    expect(await stockOf(world, world.burgerId)).toBe(10);
    expect(await stockOf(world, world.drinkId)).toBe(50);
    expect((await verifyLedgerIntegrity(world.db, world.eventId)).balanced).toBe(true);
  });

  it('never edits the original purchase or its ledger entries', async () => {
    const receipt = await buyBurgerAndDrink();
    const [original] = await world.db
      .select({ id: ledgerTransactions.id, txnRef: ledgerTransactions.txnRef })
      .from(ledgerTransactions)
      .where(eq(ledgerTransactions.referenceId, receipt.purchaseId))
      .limit(1);
    if (!original) throw new Error('original transaction missing');

    const entriesBefore = await world.db
      .select({ amount: ledgerEntries.amount })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.transactionId, original.id));

    await refundPurchase(
      world.db,
      {
        eventId: world.eventId,
        purchaseId: receipt.purchaseId,
        reason: 'Wrong item handed over',
        requestedBy: world.financeId,
      },
      'refund-immutability',
      ctx,
    );

    const entriesAfter = await world.db
      .select({ amount: ledgerEntries.amount })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.transactionId, original.id));

    // The purchase transaction is byte-for-byte what it was; the refund is a
    // separate, compensating transaction.
    expect(entriesAfter).toEqual(entriesBefore);

    const refundTxns = await world.db
      .select({ type: ledgerTransactions.type })
      .from(ledgerTransactions)
      .where(eq(ledgerTransactions.type, 'REFUND'));
    expect(refundTxns).toHaveLength(1);
  });

  it('refuses to update or delete a ledger entry even from raw SQL', async () => {
    await buyBurgerAndDrink();

    // Defence in depth: the append-only guarantee lives in the database, not
    // just in the service layer. Drizzle wraps the driver error, so the
    // trigger's message is on the cause.
    const causeMessage = async (operation: Promise<unknown>): Promise<string> => {
      try {
        await operation;
        return '';
      } catch (error) {
        const cause = (error as { cause?: { message?: string } }).cause;
        return cause?.message ?? (error as Error).message;
      }
    };

    expect(await causeMessage(world.db.update(ledgerEntries).set({ amount: 1 }))).toMatch(
      /append-only/i,
    );
    expect(await causeMessage(world.db.delete(ledgerTransactions))).toMatch(/append-only/i);
  });

  it('handles a partial refund and marks the purchase partially refunded', async () => {
    const receipt = await buyBurgerAndDrink();
    const summary = await getRefundableSummary(world.db, world.eventId, receipt.purchaseId);
    const burgerLine = summary.lines.find((line) => line.name === 'Burger');
    if (!burgerLine) throw new Error('burger line missing');

    const { refund } = await refundPurchase(
      world.db,
      {
        eventId: world.eventId,
        purchaseId: receipt.purchaseId,
        lines: [{ purchaseItemId: burgerLine.purchaseItemId, quantity: 1 }],
        reason: 'One burger was cold',
        requestedBy: world.financeId,
      },
      'refund-partial',
      ctx,
    );

    expect(refund.type).toBe('PARTIAL');
    expect(refund.amountPoints).toBe(200);
    expect(refund.purchaseStatus).toBe('PARTIALLY_REFUNDED');
    expect(await balanceOf(world, world.participantId)).toBe(4_700);
    expect(await stockOf(world, world.burgerId)).toBe(9);
  });

  it('refuses to refund more than remains', async () => {
    const receipt = await buyBurgerAndDrink();
    await refundPurchase(
      world.db,
      {
        eventId: world.eventId,
        purchaseId: receipt.purchaseId,
        reason: 'Full refund',
        requestedBy: world.financeId,
      },
      'refund-first',
      ctx,
    );

    await expect(
      refundPurchase(
        world.db,
        {
          eventId: world.eventId,
          purchaseId: receipt.purchaseId,
          reason: 'Trying again',
          requestedBy: world.financeId,
        },
        'refund-second',
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'refund_not_allowed' });

    expect(await balanceOf(world, world.participantId)).toBe(5_000);
  });

  it('can skip restocking when the goods are not coming back', async () => {
    const receipt = await buyBurgerAndDrink();
    await refundPurchase(
      world.db,
      {
        eventId: world.eventId,
        purchaseId: receipt.purchaseId,
        reason: 'Food already eaten, goodwill refund',
        restockInventory: false,
        requestedBy: world.financeId,
      },
      'refund-no-restock',
      ctx,
    );

    expect(await balanceOf(world, world.participantId)).toBe(5_000);
    expect(await stockOf(world, world.burgerId)).toBe(8);
  });

  it('is idempotent', async () => {
    const receipt = await buyBurgerAndDrink();
    const first = await refundPurchase(
      world.db,
      {
        eventId: world.eventId,
        purchaseId: receipt.purchaseId,
        reason: 'Duplicate submit test',
        requestedBy: world.financeId,
      },
      'refund-idem',
      ctx,
    );
    const second = await refundPurchase(
      world.db,
      {
        eventId: world.eventId,
        purchaseId: receipt.purchaseId,
        reason: 'Duplicate submit test',
        requestedBy: world.financeId,
      },
      'refund-idem',
      ctx,
    );

    expect(second.replayed).toBe(true);
    expect(second.refund.refundRef).toBe(first.refund.refundRef);
    expect(await balanceOf(world, world.participantId)).toBe(5_000);
    expect(await countRows(world.db, 'refunds')).toBe(1);
  });

  it('parks a large refund for approval instead of paying it out', async () => {
    await setSettings(world, { approvalThresholdRefund: 100 });
    const receipt = await buyBurgerAndDrink('refund-approval-setup');

    await expect(
      refundPurchase(
        world.db,
        {
          eventId: world.eventId,
          purchaseId: receipt.purchaseId,
          reason: 'Large refund needing sign-off',
          requestedBy: world.financeId,
        },
        'refund-approval',
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'approval_required' });

    expect(await balanceOf(world, world.participantId)).toBe(4_500);
    expect(await countRows(world.db, 'approval_requests')).toBe(1);
  });

  it('can be disabled entirely', async () => {
    const receipt = await buyBurgerAndDrink();
    await setSettings(world, { allowRefunds: false });

    await expect(
      refundPurchase(
        world.db,
        {
          eventId: world.eventId,
          purchaseId: receipt.purchaseId,
          reason: 'Should not work',
          requestedBy: world.financeId,
        },
        'refund-disabled',
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'feature_disabled' });
  });

  it('leaves the purchase status consistent after two partial refunds complete it', async () => {
    const receipt = await buyBurgerAndDrink();
    const summary = await getRefundableSummary(world.db, world.eventId, receipt.purchaseId);
    const burger = summary.lines.find((line) => line.name === 'Burger');
    const drink = summary.lines.find((line) => line.name === 'Drink');
    if (!burger || !drink) throw new Error('lines missing');

    await refundPurchase(
      world.db,
      {
        eventId: world.eventId,
        purchaseId: receipt.purchaseId,
        lines: [{ purchaseItemId: burger.purchaseItemId, quantity: 2 }],
        reason: 'Both burgers returned',
        requestedBy: world.financeId,
      },
      'refund-step-1',
      ctx,
    );
    const { refund } = await refundPurchase(
      world.db,
      {
        eventId: world.eventId,
        purchaseId: receipt.purchaseId,
        lines: [{ purchaseItemId: drink.purchaseItemId, quantity: 1 }],
        reason: 'Drink returned too',
        requestedBy: world.financeId,
      },
      'refund-step-2',
      ctx,
    );

    expect(refund.purchaseStatus).toBe('REFUNDED');
    const [row] = await world.db
      .select({ refundedPoints: purchases.refundedPoints, status: purchases.status })
      .from(purchases)
      .where(eq(purchases.id, receipt.purchaseId))
      .limit(1);
    expect(row?.refundedPoints).toBe(500);
    expect(row?.status).toBe('REFUNDED');
    expect((await verifyLedgerIntegrity(world.db, world.eventId)).balanced).toBe(true);
  });
});
