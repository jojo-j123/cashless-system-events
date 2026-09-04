import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb } from '../lib/db/client';
import {
  balanceOf,
  buildWorld,
  countRows,
  prepareDatabase,
  stockOf,
  type TestWorld,
} from './helpers';
import { resolveCard } from '../lib/services/cards';
import { topUpUser } from '../lib/services/wallet';
import { checkout } from '../lib/services/purchases';
import { refundPurchase } from '../lib/services/refunds';
import { verifyLedgerIntegrity } from '../lib/services/ledger';
import { auditLogs, notifications } from '../lib/db/schema';
import { withIdempotency } from '../lib/core/idempotency';

let world: TestWorld;
const ctx = { requestId: 'test' };

beforeEach(async () => {
  const db = await prepareDatabase();
  world = await buildWorld(db, { tapCooldownMs: 0 });
});

afterAll(async () => {
  await closeDb();
});

describe('end-to-end event flow', () => {
  /**
   * The full journey the product exists to support:
   * tap → account → cart → checkout → wallet → inventory → receipt → refund.
   */
  it('runs tap to receipt to refund with every invariant intact', async () => {
    /* 1. An admin issues points. */
    await topUpUser(
      world.db,
      {
        eventId: world.eventId,
        userId: world.participantId,
        amountPoints: 2_000,
        reason: 'Registration welcome points',
        createdBy: world.financeId,
      },
      'e2e-topup',
      ctx,
    );
    expect(await balanceOf(world, world.participantId)).toBe(2_000);

    /* 2. The cashier taps the participant's card. */
    const tapped = await resolveCard(
      world.db,
      world.eventId,
      { kind: 'TOKEN', value: world.cardToken },
      { ...ctx, storeId: world.storeId, actorUserId: world.cashierId },
    );
    expect(tapped.userId).toBe(world.participantId);
    expect(tapped.displayName).toBe('Ahmed Hassan');
    expect(tapped.balance).toBe(2_000);

    /* 3. The cashier rings up a basket and confirms. */
    const { receipt } = await checkout(
      world.db,
      {
        eventId: world.eventId,
        storeId: world.storeId,
        userId: tapped.userId,
        cardId: tapped.cardId,
        cashierUserId: world.cashierId,
        lines: [
          { productId: world.burgerId, quantity: 1 },
          { productId: world.drinkId, quantity: 1 },
          { productId: world.hoodieId, quantity: 1 },
        ],
      },
      'e2e-checkout',
      { ...ctx, actorUserId: world.cashierId },
    );

    /* 4. The receipt matches the worked example exactly. */
    expect(receipt.totalPoints).toBe(800);
    expect(receipt.balanceBefore).toBe(2_000);
    expect(receipt.balanceAfter).toBe(1_200);
    expect(receipt.status).toBe('COMPLETED');
    expect(receipt.purchaseRef).toMatch(/^PUR-\d{4}-\d{6}$/);
    expect(receipt.lines).toHaveLength(3);

    /* 5. Points moved, stock moved. */
    expect(await balanceOf(world, world.participantId)).toBe(1_200);
    expect(await stockOf(world, world.burgerId)).toBe(9);
    expect(await stockOf(world, world.drinkId)).toBe(49);
    expect(await stockOf(world, world.hoodieId)).toBe(0);

    /* 6. A tap after the purchase shows the new balance. */
    const afterTap = await resolveCard(
      world.db,
      world.eventId,
      { kind: 'TOKEN', value: world.cardToken },
      ctx,
    );
    expect(afterTap.balance).toBe(1_200);

    /* 7. The purchase is auditable and the participant was notified. */
    const audits = await world.db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(eq(auditLogs.targetId, receipt.purchaseId));
    expect(audits.map((entry) => entry.action)).toContain('purchase.completed');

    const alerts = await world.db
      .select({ type: notifications.type })
      .from(notifications)
      .where(eq(notifications.userId, world.participantId));
    expect(alerts.map((entry) => entry.type)).toContain('purchase.completed');

    /* 8. A refund compensates rather than rewrites. */
    const { refund } = await refundPurchase(
      world.db,
      {
        eventId: world.eventId,
        purchaseId: receipt.purchaseId,
        reason: 'Hoodie was the wrong size',
        requestedBy: world.financeId,
      },
      'e2e-refund',
      ctx,
    );
    expect(refund.amountPoints).toBe(800);
    expect(refund.balanceAfter).toBe(2_000);
    expect(await stockOf(world, world.hoodieId)).toBe(1);

    /* 9. Conservation still holds after all of it. */
    const integrity = await verifyLedgerIntegrity(world.db, world.eventId);
    expect(integrity.balanced).toBe(true);
    expect(integrity.eventSum).toBe(0);
    expect(integrity.driftingAccounts).toBe(0);
  });

  it('leaves nothing behind when a checkout fails mid-flight', async () => {
    await topUpUser(
      world.db,
      {
        eventId: world.eventId,
        userId: world.participantId,
        amountPoints: 300,
        reason: 'Small balance',
        createdBy: world.financeId,
      },
      'e2e-small',
      ctx,
    );

    const purchasesBefore = await countRows(world.db, 'purchases');
    const itemsBefore = await countRows(world.db, 'purchase_items');
    const movementsBefore = await countRows(world.db, 'inventory_movements');
    const entriesBefore = await countRows(world.db, 'ledger_entries');

    // The burger is affordable; the hoodie is not. The whole basket must fail.
    await expect(
      checkout(
        world.db,
        {
          eventId: world.eventId,
          storeId: world.storeId,
          userId: world.participantId,
          cashierUserId: world.cashierId,
          lines: [
            { productId: world.burgerId, quantity: 1 },
            { productId: world.hoodieId, quantity: 1 },
          ],
        },
        'e2e-rollback',
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'insufficient_points' });

    // Not one row of partial state survives.
    expect(await countRows(world.db, 'purchases')).toBe(purchasesBefore);
    expect(await countRows(world.db, 'purchase_items')).toBe(itemsBefore);
    expect(await countRows(world.db, 'inventory_movements')).toBe(movementsBefore);
    expect(await countRows(world.db, 'ledger_entries')).toBe(entriesBefore);
    expect(await balanceOf(world, world.participantId)).toBe(300);
    expect(await stockOf(world, world.burgerId)).toBe(10);
  });
});

describe('idempotency primitive', () => {
  it('runs the work once and replays the stored result', async () => {
    let executions = 0;

    const work = () =>
      withIdempotency<{ value: number }>(
        world.db,
        {
          scope: 'test.op',
          key: 'same-key',
          actorUserId: world.adminId,
          requestBody: { a: 1, b: 2 },
        },
        async () => {
          executions += 1;
          return { value: { value: 42 } };
        },
      );

    const first = await work();
    const second = await work();

    expect(executions).toBe(1);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.value).toEqual({ value: 42 });
  });

  it('hashes the body independently of key order', async () => {
    const run = (body: unknown) =>
      withIdempotency<{ ok: boolean }>(
        world.db,
        {
          scope: 'test.order',
          key: 'order-key',
          actorUserId: world.adminId,
          requestBody: body,
        },
        async () => ({ value: { ok: true } }),
      );

    await run({ a: 1, b: 2 });
    // Same content, different key order: must be treated as the same request.
    const replay = await run({ b: 2, a: 1 });
    expect(replay.replayed).toBe(true);
  });

  it('rejects the same key carrying a genuinely different body', async () => {
    const run = (body: unknown) =>
      withIdempotency<{ ok: boolean }>(
        world.db,
        {
          scope: 'test.conflict',
          key: 'conflict-key',
          actorUserId: world.adminId,
          requestBody: body,
        },
        async () => ({ value: { ok: true } }),
      );

    await run({ amount: 100 });
    await expect(run({ amount: 999 })).rejects.toMatchObject({
      code: 'idempotency_key_reused',
    });
  });

  it('does not leak a key when the work throws', async () => {
    const failing = () =>
      withIdempotency(
        world.db,
        {
          scope: 'test.failure',
          key: 'failure-key',
          actorUserId: world.adminId,
          requestBody: { x: 1 },
        },
        async () => {
          throw new Error('boom');
        },
      );

    await expect(failing()).rejects.toThrow('boom');
    // The claim rolled back with the work, so a genuine retry can proceed.
    expect(await countRows(world.db, 'idempotency_keys')).toBe(0);
  });
});
