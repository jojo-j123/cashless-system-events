import { and, count, eq, inArray, sql } from 'drizzle-orm';
import type { Database, Executor, Transaction } from '../db/client';
import {
  accounts,
  cardEvents,
  cardTaps,
  eventParticipants,
  ledgerEntries,
  nfcCards,
  purchases,
  roles,
  sessions,
  teamMembers,
  userRoles,
  users,
} from '../db/schema';
import { recordAudit, type AuditContext } from '../audit';
import { withIdempotency } from '../core/idempotency';
import { getSystemAccount, postTransaction } from './ledger';
import { ValidationError } from '../errors';

/**
 * Bulk removal of cards and participants.
 *
 * The operator picks rows; the *data* picks the verb. A row that never touched
 * the ledger is deleted outright — that is the case bulk removal actually
 * exists for: a mis-pasted import, a test batch, cards that never left the box.
 * A row with history is deactivated instead, because deleting it would either
 * be refused by the database (`accounts.owner_user_id` is ON DELETE RESTRICT)
 * or would null out the card link on real purchases and destroy the tap history
 * that clone detection reads.
 *
 * Nothing here ever deletes a ledger row. Points that belong to someone being
 * removed are forfeited to the event's SYSTEM_FORFEITURE account as an ordinary
 * balanced transaction, so the books still add up afterwards and the write-off
 * is a permanent, attributable record rather than a gap.
 */

/** A hard cap on one batch, so a runaway selection cannot hold a long write lock. */
const MAX_SELECTION = 1_000;

/** Roles that make someone staff. Staff are removed one at a time, never in bulk. */
const STAFF_ROLE_KEYS = ['SUPER_ADMIN', 'ADMIN', 'CASHIER'];

export type RemovalVerdict = 'DELETE' | 'DEACTIVATE' | 'BLOCKED';

export interface CardRemovalRow {
  cardId: string;
  cardRef: string;
  status: string;
  holder: string | null;
  verdict: RemovalVerdict;
  reason: string;
}

export interface ParticipantRemovalRow {
  userId: string;
  participantRef: string;
  displayName: string;
  verdict: RemovalVerdict;
  reason: string;
  forfeitSpendable: number;
  forfeitScore: number;
}

export interface RemovalPlan<TRow> {
  rows: TRow[];
  deleteCount: number;
  deactivateCount: number;
  blockedCount: number;
  /** Total points that will be written off to forfeiture if this plan commits. */
  pointsForfeited: number;
}

/* -------------------------------------------------------------------------- */
/* Cards                                                                      */
/* -------------------------------------------------------------------------- */

export async function planCardRemoval(
  db: Executor,
  input: { eventId: string; cardIds: string[] },
): Promise<RemovalPlan<CardRemovalRow>> {
  const ids = distinct(input.cardIds);
  assertSelectionSize(ids.length);
  if (ids.length === 0) return summarise<CardRemovalRow>([], () => 0);

  const found = await db
    .select({
      cardId: nfcCards.id,
      cardRef: nfcCards.cardRef,
      status: nfcCards.status,
      holder: users.displayName,
    })
    .from(nfcCards)
    .leftJoin(users, eq(users.id, nfcCards.assignedUserId))
    .where(and(eq(nfcCards.eventId, input.eventId), inArray(nfcCards.id, ids)));

  const [tapped, spent, historic] = await Promise.all([
    db
      .select({ cardId: cardTaps.cardId })
      .from(cardTaps)
      .where(and(eq(cardTaps.eventId, input.eventId), inArray(cardTaps.cardId, ids)))
      .groupBy(cardTaps.cardId),
    db
      .select({ cardId: purchases.cardId })
      .from(purchases)
      .where(and(eq(purchases.eventId, input.eventId), inArray(purchases.cardId, ids)))
      .groupBy(purchases.cardId),
    // card_events is append-only: a BEFORE DELETE trigger refuses to drop a row,
    // and nfc_cards cascades into it. So a card that was ever assigned, suspended
    // or replaced is undeletable at the database level, whatever we decide here —
    // this query is what keeps the plan honest about that.
    db
      .select({ cardId: cardEvents.cardId })
      .from(cardEvents)
      .where(and(eq(cardEvents.eventId, input.eventId), inArray(cardEvents.cardId, ids)))
      .groupBy(cardEvents.cardId),
  ]);

  const active = new Set<string>();
  for (const row of [...tapped, ...spent, ...historic]) {
    if (row.cardId) active.add(row.cardId);
  }

  const byId = new Map(found.map((row) => [row.cardId, row]));
  const rows: CardRemovalRow[] = ids.map((cardId) => {
    const card = byId.get(cardId);
    if (!card) {
      return {
        cardId,
        cardRef: '—',
        status: 'UNKNOWN',
        holder: null,
        verdict: 'BLOCKED',
        reason: 'Not a card in this event.',
      };
    }

    const base = {
      cardId,
      cardRef: card.cardRef,
      status: card.status,
      holder: card.holder,
    };

    if (card.status === 'DEACTIVATED') {
      return { ...base, verdict: 'BLOCKED' as const, reason: 'Already deactivated.' };
    }
    if (active.has(cardId)) {
      return {
        ...base,
        verdict: 'DEACTIVATE' as const,
        reason: 'Has a history — deactivated so the trail survives.',
      };
    }
    return { ...base, verdict: 'DELETE' as const, reason: 'Never issued — safe to delete.' };
  });

  return summarise(rows, () => 0);
}

export async function executeCardRemoval(
  db: Database,
  input: { eventId: string; cardIds: string[]; reason: string; actorUserId: string },
  idempotencyKey: string,
  context: AuditContext,
): Promise<{ plan: RemovalPlan<CardRemovalRow>; replayed: boolean }> {
  assertReason(input.reason);
  const ids = distinct(input.cardIds);
  assertSelectionSize(ids.length);

  const outcome = await withIdempotency<RemovalPlan<CardRemovalRow>>(
    db,
    {
      scope: 'card.remove',
      key: idempotencyKey,
      actorUserId: input.actorUserId,
      requestBody: { eventId: input.eventId, cardIds: ids, reason: input.reason },
    },
    async (tx) => {
      // Re-planned inside the transaction: the preview the operator saw is a
      // read from a moment ago, and a card can be tapped in between.
      const plan = await planCardRemoval(tx, { eventId: input.eventId, cardIds: ids });

      const toDelete = plan.rows.filter((row) => row.verdict === 'DELETE');
      const toDeactivate = plan.rows.filter((row) => row.verdict === 'DEACTIVATE');

      if (toDeactivate.length > 0) {
        const deactivateIds = toDeactivate.map((row) => row.cardId);
        await tx
          .update(nfcCards)
          .set({
            status: 'DEACTIVATED',
            assignedUserId: null,
            unassignedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(inArray(nfcCards.id, deactivateIds));

        await tx.insert(cardEvents).values(
          toDeactivate.map((row) => ({
            eventId: input.eventId,
            cardId: row.cardId,
            action: 'bulk_deactivated',
            fromStatus: row.status as 'ACTIVE',
            toStatus: 'DEACTIVATED' as const,
            actorUserId: input.actorUserId,
            reason: input.reason,
          })),
        );
      }

      if (toDelete.length > 0) {
        // card_events cascades; card_taps and purchases hold no rows for these
        // cards, which is exactly why they qualified for deletion.
        await tx.delete(nfcCards).where(
          inArray(
            nfcCards.id,
            toDelete.map((row) => row.cardId),
          ),
        );
      }

      await recordAudit(tx, {
        ...context,
        eventId: input.eventId,
        action: 'card.bulk_removed',
        targetType: 'nfc_card_batch',
        after: {
          deleted: plan.deleteCount,
          deactivated: plan.deactivateCount,
          blocked: plan.blockedCount,
          reason: input.reason,
          cardRefs: [...toDelete, ...toDeactivate].map((row) => row.cardRef),
        },
      });

      return { value: plan, resourceType: 'nfc_card_batch' };
    },
  );

  return { plan: outcome.value, replayed: outcome.replayed };
}

/* -------------------------------------------------------------------------- */
/* Participants                                                               */
/* -------------------------------------------------------------------------- */

export async function planParticipantRemoval(
  db: Executor,
  input: { eventId: string; userIds: string[]; actorUserId: string },
): Promise<RemovalPlan<ParticipantRemovalRow>> {
  const ids = distinct(input.userIds);
  assertSelectionSize(ids.length);
  if (ids.length === 0) {
    return summarise<ParticipantRemovalRow>([], () => 0);
  }

  const [people, staff, walletRows] = await Promise.all([
    db
      .select({
        userId: eventParticipants.userId,
        participantRef: eventParticipants.participantRef,
        displayName: users.displayName,
        isSuperAdmin: users.isSuperAdmin,
      })
      .from(eventParticipants)
      .innerJoin(users, eq(users.id, eventParticipants.userId))
      .where(
        and(eq(eventParticipants.eventId, input.eventId), inArray(eventParticipants.userId, ids)),
      ),
    // Deliberately not scoped to this event: someone who works a till anywhere
    // is staff, and staff come off a roster one at a time with a named reason.
    db
      .select({ userId: userRoles.userId })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(and(inArray(userRoles.userId, ids), inArray(roles.key, STAFF_ROLE_KEYS)))
      .groupBy(userRoles.userId),
    db
      .select({
        userId: accounts.ownerUserId,
        accountId: accounts.id,
        type: accounts.type,
        balance: accounts.balance,
      })
      .from(accounts)
      .where(and(eq(accounts.eventId, input.eventId), inArray(accounts.ownerUserId, ids))),
  ]);

  const accountIds = walletRows.map((row) => row.accountId);
  const entryRows =
    accountIds.length > 0
      ? await db
          .select({ accountId: ledgerEntries.accountId, n: count() })
          .from(ledgerEntries)
          .where(inArray(ledgerEntries.accountId, accountIds))
          .groupBy(ledgerEntries.accountId)
      : [];

  const entriesByAccount = new Map(entryRows.map((row) => [row.accountId, Number(row.n)]));
  const staffIds = new Set(staff.map((row) => row.userId));
  const byId = new Map(people.map((row) => [row.userId, row]));

  const wallets = new Map<string, { spendable: number; score: number; touched: boolean }>();
  for (const row of walletRows) {
    if (!row.userId) continue;
    const current = wallets.get(row.userId) ?? { spendable: 0, score: 0, touched: false };
    if (row.type === 'USER_SPENDABLE') current.spendable = row.balance;
    if (row.type === 'USER_SCORE') current.score = row.balance;
    // A balance with no entries behind it cannot happen through postTransaction,
    // but if it ever did, treating it as history is the safe direction to err.
    if ((entriesByAccount.get(row.accountId) ?? 0) > 0 || row.balance !== 0) {
      current.touched = true;
    }
    wallets.set(row.userId, current);
  }

  const rows: ParticipantRemovalRow[] = ids.map((userId) => {
    const person = byId.get(userId);
    if (!person) {
      return blockedPerson(userId, '—', '—', 'Not a participant in this event.');
    }

    const base = {
      userId,
      participantRef: person.participantRef,
      displayName: person.displayName,
      forfeitSpendable: 0,
      forfeitScore: 0,
    };

    if (userId === input.actorUserId) {
      return { ...base, verdict: 'BLOCKED' as const, reason: 'You cannot remove yourself.' };
    }
    if (person.isSuperAdmin || staffIds.has(userId)) {
      return {
        ...base,
        verdict: 'BLOCKED' as const,
        reason: 'Holds a staff role — remove them individually.',
      };
    }

    const wallet = wallets.get(userId) ?? { spendable: 0, score: 0, touched: false };
    if (wallet.touched) {
      return {
        ...base,
        verdict: 'DEACTIVATE' as const,
        reason: 'Has transactions — removed from the event, balance forfeited.',
        forfeitSpendable: Math.max(0, wallet.spendable),
        forfeitScore: Math.max(0, wallet.score),
      };
    }

    return {
      ...base,
      verdict: 'DELETE' as const,
      reason: 'No transactions — safe to delete.',
    };
  });

  return summarise(rows, (row) => row.forfeitSpendable + row.forfeitScore);
}

export async function executeParticipantRemoval(
  db: Database,
  input: { eventId: string; userIds: string[]; reason: string; actorUserId: string },
  idempotencyKey: string,
  context: AuditContext,
): Promise<{ plan: RemovalPlan<ParticipantRemovalRow>; replayed: boolean }> {
  assertReason(input.reason);
  const ids = distinct(input.userIds);
  assertSelectionSize(ids.length);

  const outcome = await withIdempotency<RemovalPlan<ParticipantRemovalRow>>(
    db,
    {
      scope: 'participant.remove',
      key: idempotencyKey,
      actorUserId: input.actorUserId,
      requestBody: { eventId: input.eventId, userIds: ids, reason: input.reason },
    },
    async (tx) => {
      const plan = await planParticipantRemoval(tx, {
        eventId: input.eventId,
        userIds: ids,
        actorUserId: input.actorUserId,
      });

      const leaving = plan.rows.filter((row) => row.verdict !== 'BLOCKED');
      if (leaving.length === 0) return { value: plan };

      // Forfeit first: an account must still be ACTIVE to be posted against, so
      // closing it before the write-off would make the points unreachable.
      for (const row of plan.rows) {
        if (row.verdict !== 'DEACTIVATE') continue;
        await forfeitBalances(tx, {
          eventId: input.eventId,
          row,
          reason: input.reason,
          actorUserId: input.actorUserId,
        });
      }

      const leavingIds = leaving.map((row) => row.userId);
      const deleteIds = plan.rows
        .filter((row) => row.verdict === 'DELETE')
        .map((row) => row.userId);
      const deactivateIds = plan.rows
        .filter((row) => row.verdict === 'DEACTIVATE')
        .map((row) => row.userId);

      if (deactivateIds.length > 0) {
        await tx
          .update(accounts)
          .set({ status: 'CLOSED', updatedAt: new Date() })
          .where(
            and(
              eq(accounts.eventId, input.eventId),
              inArray(accounts.ownerUserId, deactivateIds),
            ),
          );
      }

      if (deleteIds.length > 0) {
        // Safe only because these accounts carry no ledger entries; the
        // ON DELETE RESTRICT on ledger_entries.account_id is the backstop.
        await tx
          .delete(accounts)
          .where(
            and(eq(accounts.eventId, input.eventId), inArray(accounts.ownerUserId, deleteIds)),
          );
      }

      await tx
        .delete(teamMembers)
        .where(
          and(eq(teamMembers.eventId, input.eventId), inArray(teamMembers.userId, leavingIds)),
        );
      await tx
        .delete(userRoles)
        .where(and(eq(userRoles.eventId, input.eventId), inArray(userRoles.userId, leavingIds)));
      await tx
        .delete(eventParticipants)
        .where(
          and(
            eq(eventParticipants.eventId, input.eventId),
            inArray(eventParticipants.userId, leavingIds),
          ),
        );

      // A removed participant must not keep a live session.
      await tx
        .update(sessions)
        .set({ revokedAt: new Date(), revokedReason: 'Removed from event' })
        .where(and(inArray(sessions.userId, leavingIds), sql`${sessions.revokedAt} is null`));

      await retireOrphanedLogins(tx, leavingIds);

      await recordAudit(tx, {
        ...context,
        eventId: input.eventId,
        action: 'participant.bulk_removed',
        targetType: 'user_batch',
        after: {
          deleted: plan.deleteCount,
          deactivated: plan.deactivateCount,
          blocked: plan.blockedCount,
          pointsForfeited: plan.pointsForfeited,
          reason: input.reason,
          participantRefs: leaving.map((row) => row.participantRef),
        },
      });

      return { value: plan, resourceType: 'user_batch' };
    },
  );

  return { plan: outcome.value, replayed: outcome.replayed };
}

/**
 * Write off whatever the leaver still holds.
 *
 * Both wallets settle in one transaction, so a person's removal is a single
 * line in the ledger rather than two that have to be read together. The legs
 * against forfeiture merge inside `postTransaction`.
 */
async function forfeitBalances(
  tx: Transaction,
  input: {
    eventId: string;
    row: ParticipantRemovalRow;
    reason: string;
    actorUserId: string;
  },
): Promise<void> {
  const { forfeitSpendable, forfeitScore } = input.row;
  if (forfeitSpendable <= 0 && forfeitScore <= 0) return;

  const forfeiture = await getSystemAccount(tx, input.eventId, 'SYSTEM_FORFEITURE');
  const held = await tx
    .select({ id: accounts.id, type: accounts.type })
    .from(accounts)
    .where(
      and(eq(accounts.eventId, input.eventId), eq(accounts.ownerUserId, input.row.userId)),
    );

  const legs = [];
  for (const account of held) {
    const amount =
      account.type === 'USER_SPENDABLE'
        ? forfeitSpendable
        : account.type === 'USER_SCORE'
          ? forfeitScore
          : 0;
    if (amount > 0) {
      legs.push({ accountId: account.id, amount: -amount });
      legs.push({ accountId: forfeiture, amount });
    }
  }
  if (legs.length === 0) return;

  await postTransaction(tx, {
    eventId: input.eventId,
    type: 'MANUAL_ADJUSTMENT',
    reason: `Removed from event: ${input.reason}`,
    referenceType: 'participant_removal',
    referenceId: input.row.userId,
    createdBy: input.actorUserId,
    legs,
    metadata: { participantRef: input.row.participantRef, removedBy: input.actorUserId },
  });
}

/**
 * Retire logins that no longer belong to any event.
 *
 * The global `users` row is never hard-deleted here: it is the anchor for
 * anything that referenced the person outside this event, and a bulk button is
 * the wrong place to destroy an identity. Soft-deleting releases the email and
 * phone for re-registration, which is what the partial unique indexes on
 * `users` were built for.
 */
async function retireOrphanedLogins(tx: Transaction, userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;

  const stillEnrolled = await tx
    .select({ userId: eventParticipants.userId })
    .from(eventParticipants)
    .where(inArray(eventParticipants.userId, userIds))
    .groupBy(eventParticipants.userId);

  const keep = new Set(stillEnrolled.map((row) => row.userId));
  const orphaned = userIds.filter((userId) => !keep.has(userId));
  if (orphaned.length === 0) return;

  await tx
    .update(users)
    .set({ deletedAt: new Date(), status: 'DEACTIVATED', updatedAt: new Date() })
    .where(and(inArray(users.id, orphaned), sql`${users.deletedAt} is null`));
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function blockedPerson(
  userId: string,
  participantRef: string,
  displayName: string,
  reason: string,
): ParticipantRemovalRow {
  return {
    userId,
    participantRef,
    displayName,
    verdict: 'BLOCKED',
    reason,
    forfeitSpendable: 0,
    forfeitScore: 0,
  };
}

function summarise<TRow extends { verdict: RemovalVerdict }>(
  rows: TRow[],
  forfeitOf: (row: TRow) => number,
): RemovalPlan<TRow> {
  let deleteCount = 0;
  let deactivateCount = 0;
  let blockedCount = 0;
  let pointsForfeited = 0;

  for (const row of rows) {
    if (row.verdict === 'DELETE') deleteCount += 1;
    else if (row.verdict === 'DEACTIVATE') {
      deactivateCount += 1;
      pointsForfeited += forfeitOf(row);
    } else blockedCount += 1;
  }

  return { rows, deleteCount, deactivateCount, blockedCount, pointsForfeited };
}

function distinct(ids: string[]): string[] {
  return [...new Set(ids)];
}

function assertSelectionSize(size: number): void {
  if (size > MAX_SELECTION) {
    throw new ValidationError(
      `Remove at most ${MAX_SELECTION.toLocaleString()} rows at a time. Narrow the filter and repeat.`,
    );
  }
}

function assertReason(reason: string): void {
  if (reason.trim().length < 5) {
    throw new ValidationError('Give a reason of at least 5 characters for the removal.');
  }
}
