import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../lib/db/client';
import {
  balanceOf,
  buildWorld,
  countFulfilled,
  countRows,
  fund,
  inParallel,
  prepareDatabase,
  rejectionCodes,
  setSettings,
  stockOf,
  type TestWorld,
} from './helpers';
import { checkout } from '../lib/services/purchases';
import { verifyLedgerIntegrity } from '../lib/services/ledger';
import { adjustStock } from '../lib/services/inventory';
import { setEventStatus } from '../lib/services/provisioning';
import { changeCardStatus } from '../lib/services/cards';

let world: TestWorld;
const ctx = { requestId: 'test' };

beforeEach(async () => {
  const db = await prepareDatabase();
  world = await buildWorld(db);
});

afterAll(async () => {
  await closeDb();
});

function buy(lines: { productId: string; quantity: number }[], key: string) {
  return checkout(
    world.db,
    {
      eventId: world.eventId,
      storeId: world.storeId,
      userId: world.participantId,
      cashierUserId: world.cashierId,
      cardId: world.cardId,
      lines,
    },
    key,
    ctx,
  );
}

describe('checkout', () => {
  it('deducts points, reduces stock, and produces a correct receipt', async () => {
    await fund(world, world.participantId, 2_000);

    const { receipt } = await buy(
      [
        { productId: world.burgerId, quantity: 1 },
        { productId: world.drinkId, quantity: 1 },
      ],
      'buy-1',
    );

    expect(receipt.subtotalPoints).toBe(300);
    expect(receipt.totalPoints).toBe(300);
    expect(receipt.balanceBefore).toBe(2_000);
    expect(receipt.balanceAfter).toBe(1_700);
    expect(receipt.purchaseRef).toMatch(/^PUR-\d{4}-\d{6}$/);
    expect(receipt.txnRef).toMatch(/^TXN-\d{4}-\d{6}$/);
    expect(receipt.lines).toHaveLength(2);

    expect(await balanceOf(world, world.participantId)).toBe(1_700);
    expect(await stockOf(world, world.burgerId)).toBe(9);
    expect(await stockOf(world, world.drinkId)).toBe(49);
    expect((await verifyLedgerIntegrity(world.db, world.eventId)).balanced).toBe(true);
  });

  it('prices from the database, ignoring anything the client might think', async () => {
    await fund(world, world.participantId, 1_000);
    // Three burgers at the stored price of 200 is 600 — no client input can
    // change that figure.
    const { receipt } = await buy([{ productId: world.burgerId, quantity: 3 }], 'buy-priced');
    expect(receipt.totalPoints).toBe(600);
    expect(await balanceOf(world, world.participantId)).toBe(400);
  });

  it('refuses when the balance is short and changes nothing', async () => {
    await fund(world, world.participantId, 150);

    await expect(buy([{ productId: world.burgerId, quantity: 1 }], 'buy-short')).rejects.toMatchObject(
      { code: 'insufficient_points' },
    );

    expect(await balanceOf(world, world.participantId)).toBe(150);
    expect(await stockOf(world, world.burgerId)).toBe(10);
    // Nothing half-written: no purchase row survives the rollback.
    expect(await countRows(world.db, 'purchases')).toBe(0);
  });

  it('refuses to oversell and leaves stock intact', async () => {
    await fund(world, world.participantId, 10_000);

    await expect(buy([{ productId: world.hoodieId, quantity: 2 }], 'buy-oversell')).rejects.toMatchObject(
      { code: 'out_of_stock' },
    );

    expect(await stockOf(world, world.hoodieId)).toBe(1);
    expect(await balanceOf(world, world.participantId)).toBe(10_000);
  });

  it('sells untracked items without touching inventory', async () => {
    await fund(world, world.participantId, 1_000);
    const { receipt } = await buy([{ productId: world.unlimitedId, quantity: 2 }], 'buy-untracked');
    expect(receipt.totalPoints).toBe(300);
    expect(await stockOf(world, world.unlimitedId)).toBe(0);
  });

  it('merges duplicate lines for the same product', async () => {
    await fund(world, world.participantId, 1_000);
    const { receipt } = await buy(
      [
        { productId: world.burgerId, quantity: 1 },
        { productId: world.burgerId, quantity: 2 },
      ],
      'buy-merged',
    );
    expect(receipt.lines).toHaveLength(1);
    expect(receipt.lines[0]?.quantity).toBe(3);
    expect(receipt.totalPoints).toBe(600);
    expect(await stockOf(world, world.burgerId)).toBe(7);
  });

  it('rejects a product that belongs to another store', async () => {
    await fund(world, world.participantId, 1_000);
    await expect(
      checkout(
        world.db,
        {
          eventId: world.eventId,
          storeId: world.otherStoreId,
          userId: world.participantId,
          cashierUserId: world.cashierId,
          lines: [{ productId: world.burgerId, quantity: 1 }],
        },
        'buy-wrong-store',
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'product_unavailable' });
  });

  it('rejects an empty basket', async () => {
    await expect(buy([], 'buy-empty')).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('rejects a card that was suspended after the tap', async () => {
    await fund(world, world.participantId, 1_000);
    await changeCardStatus(
      world.db,
      { eventId: world.eventId, cardId: world.cardId, status: 'LOST', reason: 'Reported lost' },
      ctx,
    );

    // The POS resolved this card a moment ago; the server re-checks anyway.
    await expect(buy([{ productId: world.burgerId, quantity: 1 }], 'buy-lost-card')).rejects.toMatchObject(
      { code: 'card_not_usable' },
    );
    expect(await balanceOf(world, world.participantId)).toBe(1_000);
  });

  it('refuses to trade when the event is paused', async () => {
    await fund(world, world.participantId, 1_000);
    await setEventStatus(world.db, world.eventId, 'PAUSED', ctx);

    await expect(buy([{ productId: world.burgerId, quantity: 1 }], 'buy-paused')).rejects.toMatchObject(
      { code: 'event_not_operational' },
    );
  });

  it('refuses a basket above the single-purchase limit', async () => {
    await setSettings(world, { maxSinglePurchase: 500 });
    await fund(world, world.participantId, 10_000);

    await expect(buy([{ productId: world.burgerId, quantity: 3 }], 'buy-over-limit')).rejects.toMatchObject(
      { code: 'limit_exceeded' },
    );
  });
});

describe('inventory concurrency', () => {
  it('sells the last unit exactly once when several cashiers race', async () => {
    await fund(world, world.participantId, 10_000);
    await fund(world, world.otherParticipantId, 10_000);

    // One hoodie in stock, four simultaneous attempts across two participants.
    const attempt = (userId: string, key: string) => async () =>
      checkout(
        world.db,
        {
          eventId: world.eventId,
          storeId: world.storeId,
          userId,
          cashierUserId: world.cashierId,
          lines: [{ productId: world.hoodieId, quantity: 1 }],
        },
        key,
        ctx,
      );

    const results = await inParallel([
      attempt(world.participantId, 'stock-a'),
      attempt(world.otherParticipantId, 'stock-b'),
      attempt(world.participantId, 'stock-c'),
      attempt(world.otherParticipantId, 'stock-d'),
    ]);

    expect(countFulfilled(results)).toBe(1);
    expect(rejectionCodes(results)).toEqual(expect.arrayContaining(['out_of_stock']));
    expect(await stockOf(world, world.hoodieId)).toBe(0);
    expect((await verifyLedgerIntegrity(world.db, world.eventId)).balanced).toBe(true);
  });

  it('never lets concurrent sales drive stock below zero', async () => {
    await fund(world, world.participantId, 10_000);
    await adjustStock(
      world.db,
      {
        eventId: world.eventId,
        productId: world.drinkId,
        quantityDelta: -45,
        type: 'ADJUSTMENT',
        reason: 'Down to five for the test',
        actorUserId: world.adminId,
      },
      ctx,
    );
    expect(await stockOf(world, world.drinkId)).toBe(5);

    const results = await inParallel(
      Array.from({ length: 12 }, (_, index) => () =>
        checkout(
          world.db,
          {
            eventId: world.eventId,
            storeId: world.storeId,
            userId: world.participantId,
            cashierUserId: world.cashierId,
            lines: [{ productId: world.drinkId, quantity: 1 }],
          },
          `drain-${index}`,
          ctx,
        ),
      ),
    );

    expect(countFulfilled(results)).toBe(5);
    expect(await stockOf(world, world.drinkId)).toBe(0);
  });
});

describe('inventory adjustments', () => {
  it('records an auditable movement for every change', async () => {
    const before = await countRows(world.db, 'inventory_movements');

    await adjustStock(
      world.db,
      {
        eventId: world.eventId,
        productId: world.burgerId,
        quantityDelta: 25,
        type: 'RESTOCK',
        reason: 'Delivery from supplier',
        actorUserId: world.adminId,
      },
      ctx,
    );

    expect(await stockOf(world, world.burgerId)).toBe(35);
    expect(await countRows(world.db, 'inventory_movements')).toBe(before + 1);
  });

  it('refuses an adjustment that would go negative', async () => {
    await expect(
      adjustStock(
        world.db,
        {
          eventId: world.eventId,
          productId: world.burgerId,
          quantityDelta: -50,
          type: 'DAMAGE',
          reason: 'Water damage',
          actorUserId: world.adminId,
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'insufficient_stock' });

    expect(await stockOf(world, world.burgerId)).toBe(10);
  });
});

describe('the receipt names who was charged', () => {
  it('carries the buyer name, not an empty string', async () => {
    // The till shows this to confirm the right person was charged. It was
    // populated only for a self purchase, so a cashier saw a balance with no
    // name against it.
    await fund(world, world.participantId, 1_000);

    const { receipt } = await checkout(
      world.db,
      {
        eventId: world.eventId,
        storeId: world.storeId,
        userId: world.participantId,
        cardId: null,
        terminalId: null,
        cashierUserId: world.cashierId,
        lines: [{ productId: world.drinkId, quantity: 1 }],
        notes: null,
      },
      `receipt-name-${Math.random()}`,
      { actorUserId: world.cashierId, requestId: 'test' },
    );

    expect(receipt.participantName).toBe('Ahmed Hassan');
  });
});
