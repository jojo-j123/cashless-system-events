import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { Database, Executor, Transaction } from '../db/client';
import {
  accounts,
  approvalRequests,
  ledgerEntries,
  ledgerTransactions,
  teamMembers,
  teams,
  topups,
  transfers,
  users,
} from '../db/schema';
import type { allocationMode } from '../db/schema';
import { recordAudit, type AuditContext } from '../audit';
import { nextRef } from '../core/refs';
import { withIdempotency } from '../core/idempotency';
import { getEventSettings } from '../settings/service';
import {
  ApprovalRequiredError,
  ConflictError,
  FeatureDisabledError,
  LimitExceededError,
  NotFoundError,
  ValidationError,
} from '../errors';
import {
  assertEventAcceptsPoints,
  getSystemAccount,
  getTeamAccount,
  getUserAccount,
  postTransaction,
  type LedgerLeg,
} from './ledger';
import { notify } from './notifications';

export type AllocationMode = (typeof allocationMode.enumValues)[number];

/**
 * Either the operation happened, or it was parked for a second approver.
 *
 * "Parked" cannot be signalled by throwing from inside the transaction: the
 * throw would roll back the very approval request it was trying to record. So
 * the work returns this, the transaction commits, and the caller raises
 * ApprovalRequiredError afterwards. Replaying the same idempotency key returns
 * the same parked request rather than creating a second one.
 */
type Parked = { kind: 'APPROVAL_REQUIRED'; approvalRequestId: string; threshold: number };
type Outcome<T> = ({ kind: 'COMPLETED' } & T) | Parked;

export interface TopUpResult {
  topupId: string;
  topupRef: string;
  txnRef: string;
  amountPoints: number;
  recipients: { userId?: string; teamId?: string; balanceBefore: number; balanceAfter: number }[];
}

/* -------------------------------------------------------------------------- */
/* Individual top-up                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Issue points to one participant.
 *
 * "Top-up" here means an authorised staff member creating points — there is no
 * money leg. The counterparty is the event's SYSTEM_ISSUANCE account, which
 * goes negative by exactly the amount issued. That is how total points in
 * circulation stays provable.
 */
export async function topUpUser(
  db: Database,
  input: {
    eventId: string;
    userId: string;
    amountPoints: number;
    reason: string;
    source?: 'ADMIN_PANEL' | 'POS_COUNTER' | 'BULK_CSV' | 'API' | 'SYSTEM';
    terminalId?: string | null;
    createdBy: string;
    batchId?: string | null;
    /** Set when a two-person approval already cleared this. */
    preApproved?: boolean;
  },
  idempotencyKey: string,
  context: AuditContext,
): Promise<{ result: TopUpResult; replayed: boolean }> {
  assertPositiveAmount(input.amountPoints);
  assertReason(input.reason);

  const settings = await getEventSettings(db, input.eventId);
  await assertEventAcceptsPoints(db, input.eventId);

  if (input.amountPoints > settings.maxSingleTopUp) {
    throw new LimitExceededError(
      'maxSingleTopUp',
      settings.maxSingleTopUp,
      input.amountPoints,
      `A single top-up cannot exceed ${settings.maxSingleTopUp.toLocaleString()} points.`,
    );
  }

  const outcome = await withIdempotency<Outcome<{ result: TopUpResult }>>(
    db,
    {
      scope: 'wallet.topup.user',
      key: idempotencyKey,
      actorUserId: input.createdBy,
      requestBody: {
        eventId: input.eventId,
        userId: input.userId,
        amountPoints: input.amountPoints,
        reason: input.reason,
      },
    },
    async (tx) => {
      if (
        !input.preApproved &&
        settings.approvalThresholdTopUp > 0 &&
        input.amountPoints >= settings.approvalThresholdTopUp
      ) {
        const [request] = await tx
          .insert(approvalRequests)
          .values({
            eventId: input.eventId,
            type: 'LARGE_TOP_UP',
            amountPoints: input.amountPoints,
            payload: { userId: input.userId, amountPoints: input.amountPoints },
            reason: input.reason,
            requestedBy: input.createdBy,
          })
          .returning({ id: approvalRequests.id });
        if (!request) throw new Error('Failed to record approval request');
        return {
          value: {
            kind: 'APPROVAL_REQUIRED',
            approvalRequestId: request.id,
            threshold: settings.approvalThresholdTopUp,
          },
          resourceType: 'approval_request',
          resourceId: request.id,
        };
      }

      const accountId = await getUserAccount(tx, input.eventId, input.userId);
      const issuanceId = await getSystemAccount(tx, input.eventId, 'SYSTEM_ISSUANCE');
      const topupRef = await nextRef(tx, 'topup');

      const [topup] = await tx
        .insert(topups)
        .values({
          eventId: input.eventId,
          topupRef,
          targetType: 'USER',
          userId: input.userId,
          amountPoints: input.amountPoints,
          reason: input.reason,
          source: input.source ?? 'ADMIN_PANEL',
          terminalId: input.terminalId ?? null,
          batchId: input.batchId ?? null,
          status: 'COMPLETED',
          createdBy: input.createdBy,
          completedAt: new Date(),
        })
        .returning({ id: topups.id });
      if (!topup) throw new Error('Failed to record top-up');

      const posted = await postTransaction(tx, {
        eventId: input.eventId,
        type: 'TOP_UP',
        reason: input.reason,
        referenceType: 'topup',
        referenceId: topup.id,
        createdBy: input.createdBy,
        maxHolderBalance: settings.maxWalletBalance,
        legs: [
          { accountId: issuanceId, amount: -input.amountPoints },
          { accountId, amount: input.amountPoints },
        ],
        metadata: { topupRef, source: input.source ?? 'ADMIN_PANEL' },
      });

      await tx
        .update(topups)
        .set({ ledgerTransactionId: posted.transactionId })
        .where(eq(topups.id, topup.id));

      await recordAudit(tx, {
        ...context,
        eventId: input.eventId,
        action: 'wallet.topup',
        targetType: 'user',
        targetId: input.userId,
        after: {
          topupRef,
          amount: input.amountPoints,
          balanceAfter: posted.balanceFor(accountId).after,
        },
        metadata: { reason: input.reason, source: input.source ?? 'ADMIN_PANEL' },
      });

      const movement = posted.balanceFor(accountId);
      return {
        value: {
          kind: 'COMPLETED',
          result: {
            topupId: topup.id,
            topupRef,
            txnRef: posted.txnRef,
            amountPoints: input.amountPoints,
            recipients: [
              { userId: input.userId, balanceBefore: movement.before, balanceAfter: movement.after },
            ],
          },
        },
        resourceType: 'topup',
        resourceId: topup.id,
      };
    },
  );

  if (outcome.value.kind === 'APPROVAL_REQUIRED') {
    throw new ApprovalRequiredError(outcome.value.approvalRequestId, outcome.value.threshold);
  }
  const completed = outcome.value.result;

  if (!outcome.replayed) {
    await notify(db, {
      eventId: input.eventId,
      userId: input.userId,
      type: 'wallet.points_added',
      title: `+${input.amountPoints.toLocaleString()} points`,
      body: input.reason,
      severity: 'SUCCESS',
      data: { amount: input.amountPoints, topupRef: completed.topupRef },
    });
  }

  return { result: completed, replayed: outcome.replayed };
}

/* -------------------------------------------------------------------------- */
/* Team allocation                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Allocate points to a team.
 *
 * The mode makes the intent explicit, because "give the team 10,000 points"
 * is genuinely ambiguous and guessing wrong is expensive:
 *
 *  - TEAM_WALLET               a shared spendable pot the team manager controls
 *  - TEAM_SCORE                leaderboard only, not spendable by anyone
 *  - SPLIT_EQUALLY_TO_MEMBERS  the amount divided across members' own wallets
 *  - EACH_MEMBER_FULL_AMOUNT   every member receives the full amount
 */
export async function allocateToTeam(
  db: Database,
  input: {
    eventId: string;
    teamId: string;
    amountPoints: number;
    mode: AllocationMode;
    reason: string;
    createdBy: string;
  },
  idempotencyKey: string,
  context: AuditContext,
): Promise<{ result: TopUpResult; replayed: boolean }> {
  assertPositiveAmount(input.amountPoints);
  assertReason(input.reason);

  const settings = await getEventSettings(db, input.eventId);
  await assertEventAcceptsPoints(db, input.eventId);

  const outcome = await withIdempotency<TopUpResult>(
    db,
    {
      scope: 'wallet.topup.team',
      key: idempotencyKey,
      actorUserId: input.createdBy,
      requestBody: {
        eventId: input.eventId,
        teamId: input.teamId,
        amountPoints: input.amountPoints,
        mode: input.mode,
        reason: input.reason,
      },
    },
    async (tx) => {
      const [team] = await tx
        .select({ id: teams.id, name: teams.name })
        .from(teams)
        .where(and(eq(teams.id, input.teamId), eq(teams.eventId, input.eventId)))
        .limit(1);
      if (!team) throw new NotFoundError('That team');

      const issuanceId = await getSystemAccount(tx, input.eventId, 'SYSTEM_ISSUANCE');
      const topupRef = await nextRef(tx, 'topup');

      const [topup] = await tx
        .insert(topups)
        .values({
          eventId: input.eventId,
          topupRef,
          targetType: 'TEAM',
          teamId: input.teamId,
          allocationMode: input.mode,
          amountPoints: input.amountPoints,
          reason: input.reason,
          source: 'ADMIN_PANEL',
          status: 'COMPLETED',
          createdBy: input.createdBy,
          completedAt: new Date(),
        })
        .returning({ id: topups.id });
      if (!topup) throw new Error('Failed to record allocation');

      const { legs, recipientAccounts, totalIssued } = await buildAllocationLegs(
        tx,
        input,
        issuanceId,
      );

      const posted = await postTransaction(tx, {
        eventId: input.eventId,
        type: input.mode === 'TEAM_SCORE' ? 'SCORE_AWARD' : 'TEAM_ALLOCATION',
        reason: input.reason,
        referenceType: 'topup',
        referenceId: topup.id,
        createdBy: input.createdBy,
        // Score is a competition number, not spendable value, so the wallet
        // cap does not apply to it.
        ...(input.mode === 'TEAM_SCORE' ? {} : { maxHolderBalance: settings.maxWalletBalance }),
        legs,
        metadata: { topupRef, mode: input.mode, teamId: input.teamId, totalIssued },
      });

      await tx
        .update(topups)
        .set({ ledgerTransactionId: posted.transactionId })
        .where(eq(topups.id, topup.id));

      await recordAudit(tx, {
        ...context,
        eventId: input.eventId,
        action: 'wallet.team_allocation',
        targetType: 'team',
        targetId: input.teamId,
        after: { topupRef, amount: input.amountPoints, mode: input.mode, totalIssued },
        metadata: { reason: input.reason, recipientCount: recipientAccounts.length },
      });

      return {
        value: {
          topupId: topup.id,
          topupRef,
          txnRef: posted.txnRef,
          amountPoints: totalIssued,
          recipients: recipientAccounts.map((entry) => {
            const movement = posted.balanceFor(entry.accountId);
            return {
              ...(entry.userId ? { userId: entry.userId } : {}),
              ...(entry.teamId ? { teamId: entry.teamId } : {}),
              balanceBefore: movement.before,
              balanceAfter: movement.after,
            };
          }),
        },
        resourceType: 'topup',
        resourceId: topup.id,
      };
    },
  );

  if (!outcome.replayed) {
    const recipients = outcome.value.recipients.filter((entry) => entry.userId);
    for (const recipient of recipients) {
      if (!recipient.userId) continue;
      await notify(db, {
        eventId: input.eventId,
        userId: recipient.userId,
        type: 'wallet.points_added',
        title: 'Team points received',
        body: input.reason,
        severity: 'SUCCESS',
        data: { balance: recipient.balanceAfter },
      });
    }
  }

  return { result: outcome.value, replayed: outcome.replayed };
}

async function buildAllocationLegs(
  tx: Transaction,
  input: { eventId: string; teamId: string; amountPoints: number; mode: AllocationMode },
  issuanceId: string,
): Promise<{
  legs: LedgerLeg[];
  recipientAccounts: { accountId: string; userId?: string; teamId?: string }[];
  totalIssued: number;
}> {
  if (input.mode === 'TEAM_WALLET' || input.mode === 'TEAM_SCORE') {
    const accountId = await getTeamAccount(
      tx,
      input.eventId,
      input.teamId,
      input.mode === 'TEAM_SCORE' ? 'TEAM_SCORE' : 'TEAM_SPENDABLE',
    );
    return {
      legs: [
        { accountId: issuanceId, amount: -input.amountPoints },
        { accountId, amount: input.amountPoints },
      ],
      recipientAccounts: [{ accountId, teamId: input.teamId }],
      totalIssued: input.amountPoints,
    };
  }

  const members = await tx
    .select({ userId: teamMembers.userId })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, input.teamId), eq(teamMembers.eventId, input.eventId)));

  if (members.length === 0) {
    throw new ConflictError('That team has no members to allocate to.', 'team_empty');
  }

  const perMember =
    input.mode === 'SPLIT_EQUALLY_TO_MEMBERS'
      ? Math.floor(input.amountPoints / members.length)
      : input.amountPoints;

  if (perMember <= 0) {
    throw new ValidationError(
      `${input.amountPoints} points split across ${members.length} members is less than 1 point each.`,
    );
  }

  const legs: LedgerLeg[] = [];
  const recipientAccounts: { accountId: string; userId?: string }[] = [];
  for (const member of members) {
    const accountId = await getUserAccount(tx, input.eventId, member.userId);
    legs.push({ accountId, amount: perMember });
    recipientAccounts.push({ accountId, userId: member.userId });
  }

  const totalIssued = perMember * members.length;
  legs.push({ accountId: issuanceId, amount: -totalIssued });

  return {
    legs,
    recipientAccounts,
    totalIssued,
  };
}

/* -------------------------------------------------------------------------- */
/* Manual adjustment                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Move a wallet up or down by hand.
 *
 * The most dangerous operation in the system, so: a reason is mandatory, the
 * before/after is recorded, and amounts at or above the configured threshold
 * park as an approval request rather than executing.
 */
export async function adjustWallet(
  db: Database,
  input: {
    eventId: string;
    userId: string;
    /** Signed: positive credits the wallet, negative debits it. */
    amountPoints: number;
    reason: string;
    createdBy: string;
    preApproved?: boolean;
  },
  idempotencyKey: string,
  context: AuditContext,
): Promise<{ txnRef: string; balanceBefore: number; balanceAfter: number; replayed: boolean }> {
  if (!Number.isInteger(input.amountPoints) || input.amountPoints === 0) {
    throw new ValidationError('An adjustment must be a non-zero whole number of points.');
  }
  assertReason(input.reason, 5);

  const settings = await getEventSettings(db, input.eventId);
  const magnitude = Math.abs(input.amountPoints);

  const outcome = await withIdempotency<
    Outcome<{ txnRef: string; balanceBefore: number; balanceAfter: number }>
  >(
    db,
    {
      scope: 'wallet.adjust',
      key: idempotencyKey,
      actorUserId: input.createdBy,
      requestBody: {
        eventId: input.eventId,
        userId: input.userId,
        amountPoints: input.amountPoints,
        reason: input.reason,
      },
    },
    async (tx) => {
      if (
        !input.preApproved &&
        settings.approvalThresholdAdjustment > 0 &&
        magnitude >= settings.approvalThresholdAdjustment
      ) {
        const [request] = await tx
          .insert(approvalRequests)
          .values({
            eventId: input.eventId,
            type: 'MANUAL_ADJUSTMENT',
            amountPoints: magnitude,
            payload: { userId: input.userId, amountPoints: input.amountPoints },
            reason: input.reason,
            requestedBy: input.createdBy,
          })
          .returning({ id: approvalRequests.id });
        if (!request) throw new Error('Failed to record approval request');
        return {
          value: {
            kind: 'APPROVAL_REQUIRED',
            approvalRequestId: request.id,
            threshold: settings.approvalThresholdAdjustment,
          },
          resourceType: 'approval_request',
          resourceId: request.id,
        };
      }

      const accountId = await getUserAccount(tx, input.eventId, input.userId);
      // Credits mint from issuance; debits are written off to forfeiture, so
      // the two directions stay distinguishable in reporting.
      const counterparty = await getSystemAccount(
        tx,
        input.eventId,
        input.amountPoints > 0 ? 'SYSTEM_ISSUANCE' : 'SYSTEM_FORFEITURE',
      );

      const posted = await postTransaction(tx, {
        eventId: input.eventId,
        type: 'MANUAL_ADJUSTMENT',
        reason: input.reason,
        referenceType: 'adjustment',
        referenceId: null,
        createdBy: input.createdBy,
        maxHolderBalance: settings.maxWalletBalance,
        legs: [
          { accountId, amount: input.amountPoints },
          { accountId: counterparty, amount: -input.amountPoints },
        ],
        metadata: { adjustedBy: input.createdBy },
      });

      const movement = posted.balanceFor(accountId);

      await recordAudit(tx, {
        ...context,
        eventId: input.eventId,
        action: 'wallet.manual_adjustment',
        targetType: 'user',
        targetId: input.userId,
        before: { balance: movement.before },
        after: { balance: movement.after },
        metadata: { amount: input.amountPoints, reason: input.reason, txnRef: posted.txnRef },
      });

      return {
        value: {
          kind: 'COMPLETED',
          txnRef: posted.txnRef,
          balanceBefore: movement.before,
          balanceAfter: movement.after,
        },
      };
    },
  );

  if (outcome.value.kind === 'APPROVAL_REQUIRED') {
    throw new ApprovalRequiredError(outcome.value.approvalRequestId, outcome.value.threshold);
  }
  const adjusted = outcome.value;

  if (!outcome.replayed) {
    await notify(db, {
      eventId: input.eventId,
      userId: input.userId,
      type: 'wallet.adjusted',
      title:
        input.amountPoints > 0
          ? `+${input.amountPoints.toLocaleString()} points`
          : `${input.amountPoints.toLocaleString()} points`,
      body: input.reason,
      severity: input.amountPoints > 0 ? 'SUCCESS' : 'WARNING',
      data: { amount: input.amountPoints },
    });
  }

  return {
    txnRef: adjusted.txnRef,
    balanceBefore: adjusted.balanceBefore,
    balanceAfter: adjusted.balanceAfter,
    replayed: outcome.replayed,
  };
}

/* -------------------------------------------------------------------------- */
/* Peer-to-peer transfer                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Send points to another participant.
 *
 * Off by default, and that default is deliberate: at a live event, transfers
 * are the mechanism by which points get sold for cash outside the system. When
 * enabled they are capped per transfer and per day, and rate limited.
 */
export async function transferPoints(
  db: Database,
  input: {
    eventId: string;
    fromUserId: string;
    toUserId: string;
    amountPoints: number;
    note?: string | null;
  },
  idempotencyKey: string,
  context: AuditContext,
): Promise<{ transferRef: string; txnRef: string; balanceAfter: number; replayed: boolean }> {
  assertPositiveAmount(input.amountPoints);
  if (input.fromUserId === input.toUserId) {
    throw new ValidationError('You cannot send points to yourself.');
  }

  const settings = await getEventSettings(db, input.eventId);
  if (!settings.allowTransfers) {
    throw new FeatureDisabledError(
      'transfers',
      'Sending points to other participants is turned off for this event.',
    );
  }
  if (input.amountPoints > settings.maxSingleTransfer) {
    throw new LimitExceededError(
      'maxSingleTransfer',
      settings.maxSingleTransfer,
      input.amountPoints,
      `The most you can send at once is ${settings.maxSingleTransfer.toLocaleString()} points.`,
    );
  }

  const sentToday = await sumTransfersToday(db, input.eventId, input.fromUserId);
  if (sentToday + input.amountPoints > settings.dailyTransferLimit) {
    throw new LimitExceededError(
      'dailyTransferLimit',
      settings.dailyTransferLimit,
      sentToday + input.amountPoints,
      `That would exceed your daily send limit of ${settings.dailyTransferLimit.toLocaleString()} points.`,
    );
  }

  const outcome = await withIdempotency<{
    transferRef: string;
    txnRef: string;
    balanceAfter: number;
  }>(
    db,
    {
      scope: 'wallet.transfer',
      key: idempotencyKey,
      actorUserId: input.fromUserId,
      requestBody: {
        eventId: input.eventId,
        fromUserId: input.fromUserId,
        toUserId: input.toUserId,
        amountPoints: input.amountPoints,
      },
    },
    async (tx) => {
      const fromAccountId = await getUserAccount(tx, input.eventId, input.fromUserId);
      const toAccountId = await getUserAccount(tx, input.eventId, input.toUserId);
      const transferRef = await nextRef(tx, 'transfer');

      const [transfer] = await tx
        .insert(transfers)
        .values({
          eventId: input.eventId,
          transferRef,
          fromUserId: input.fromUserId,
          toUserId: input.toUserId,
          amountPoints: input.amountPoints,
          note: input.note ?? null,
          status: 'COMPLETED',
        })
        .returning({ id: transfers.id });
      if (!transfer) throw new Error('Failed to record transfer');

      const posted = await postTransaction(tx, {
        eventId: input.eventId,
        type: 'TRANSFER',
        reason: input.note?.trim() || 'Points sent to another participant',
        referenceType: 'transfer',
        referenceId: transfer.id,
        createdBy: input.fromUserId,
        maxHolderBalance: settings.maxWalletBalance,
        legs: [
          { accountId: fromAccountId, amount: -input.amountPoints },
          { accountId: toAccountId, amount: input.amountPoints },
        ],
        metadata: { transferRef },
      });

      await tx
        .update(transfers)
        .set({ ledgerTransactionId: posted.transactionId })
        .where(eq(transfers.id, transfer.id));

      await recordAudit(tx, {
        ...context,
        eventId: input.eventId,
        action: 'wallet.transfer',
        targetType: 'transfer',
        targetId: transfer.id,
        after: {
          transferRef,
          from: input.fromUserId,
          to: input.toUserId,
          amount: input.amountPoints,
        },
      });

      return {
        value: {
          transferRef,
          txnRef: posted.txnRef,
          balanceAfter: posted.balanceFor(fromAccountId).after,
        },
        resourceType: 'transfer',
        resourceId: transfer.id,
      };
    },
  );

  if (!outcome.replayed) {
    const [sender] = await db
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.id, input.fromUserId))
      .limit(1);
    await notify(db, {
      eventId: input.eventId,
      userId: input.toUserId,
      type: 'wallet.transfer_received',
      title: `+${input.amountPoints.toLocaleString()} points received`,
      body: `${sender?.displayName ?? 'A participant'} sent you points.`,
      severity: 'SUCCESS',
      data: { amount: input.amountPoints, transferRef: outcome.value.transferRef },
    });
  }

  return { ...outcome.value, replayed: outcome.replayed };
}

async function sumTransfersToday(
  db: Executor,
  eventId: string,
  fromUserId: string,
): Promise<number> {
  const result = await db.execute<{ total: string }>(sql`
    select coalesce(sum(amount_points), 0)::text as total
      from transfers
     where event_id = ${eventId}
       and from_user_id = ${fromUserId}
       and status = 'COMPLETED'
       and created_at >= date_trunc('day', now())
  `);
  return Number(result.rows[0]?.total ?? 0);
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

export interface WalletSummary {
  accountId: string;
  balance: number;
  lifetimeEarned: number;
  lifetimeSpent: number;
  scoreAccountId: string | null;
  scoreBalance: number;
  lowBalance: boolean;
}

export async function getWalletSummary(
  db: Executor,
  eventId: string,
  userId: string,
): Promise<WalletSummary> {
  const rows = await db
    .select({
      id: accounts.id,
      type: accounts.type,
      balance: accounts.balance,
      lifetimeCredited: accounts.lifetimeCredited,
      lifetimeDebited: accounts.lifetimeDebited,
    })
    .from(accounts)
    .where(
      and(
        eq(accounts.eventId, eventId),
        eq(accounts.ownerUserId, userId),
        inArray(accounts.type, ['USER_SPENDABLE', 'USER_SCORE']),
      ),
    );

  const spendable = rows.find((row) => row.type === 'USER_SPENDABLE');
  if (!spendable) throw new NotFoundError('A wallet for this participant');
  const score = rows.find((row) => row.type === 'USER_SCORE');
  const settings = await getEventSettings(db, eventId);

  return {
    accountId: spendable.id,
    balance: spendable.balance,
    lifetimeEarned: spendable.lifetimeCredited,
    lifetimeSpent: spendable.lifetimeDebited,
    scoreAccountId: score?.id ?? null,
    scoreBalance: score?.balance ?? 0,
    lowBalance: spendable.balance < settings.lowBalanceThreshold,
  };
}

export interface LedgerPage {
  entries: {
    entryId: string;
    txnRef: string;
    type: string;
    amount: number;
    balanceAfter: number;
    reason: string;
    referenceType: string | null;
    referenceId: string | null;
    createdAt: string;
  }[];
  nextCursor: string | null;
}

/**
 * Ledger history for one account, newest first.
 *
 * Keyset pagination on (created_at, id): stable and index-friendly even when
 * new rows land between page fetches, which OFFSET is not.
 */
export async function getWalletTransactions(
  db: Executor,
  accountId: string,
  options: { limit?: number; cursor?: string | null; from?: Date; to?: Date } = {},
): Promise<LedgerPage> {
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
  const conditions = [eq(ledgerEntries.accountId, accountId)];

  if (options.from) conditions.push(gte(ledgerEntries.createdAt, options.from));
  if (options.to) conditions.push(lte(ledgerEntries.createdAt, options.to));
  if (options.cursor) {
    const decoded = decodeCursor(options.cursor);
    if (decoded) {
      conditions.push(
        sql`(${ledgerEntries.createdAt}, ${ledgerEntries.id}) < (${decoded.createdAt}, ${decoded.id})`,
      );
    }
  }

  const rows = await db
    .select({
      entryId: ledgerEntries.id,
      amount: ledgerEntries.amount,
      balanceAfter: ledgerEntries.balanceAfter,
      createdAt: ledgerEntries.createdAt,
      txnRef: ledgerTransactions.txnRef,
      type: ledgerTransactions.type,
      reason: ledgerTransactions.reason,
      referenceType: ledgerTransactions.referenceType,
      referenceId: ledgerTransactions.referenceId,
    })
    .from(ledgerEntries)
    .innerJoin(ledgerTransactions, eq(ledgerTransactions.id, ledgerEntries.transactionId))
    .where(and(...conditions))
    .orderBy(desc(ledgerEntries.createdAt), desc(ledgerEntries.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const last = page.at(-1);

  return {
    entries: page.map((row) => ({
      entryId: row.entryId,
      txnRef: row.txnRef,
      type: row.type,
      amount: row.amount,
      balanceAfter: row.balanceAfter,
      reason: row.reason,
      referenceType: row.referenceType,
      referenceId: row.referenceId,
      createdAt: row.createdAt.toISOString(),
    })),
    nextCursor:
      rows.length > limit && last ? encodeCursor(last.createdAt, last.entryId) : null,
  };
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: string; id: string } | null {
  try {
    const [createdAt, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    if (!createdAt || !id) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Guards                                                                     */
/* -------------------------------------------------------------------------- */

function assertPositiveAmount(amount: number): void {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new ValidationError('Amount must be a whole number of points above zero.');
  }
  if (amount > 100_000_000) {
    throw new ValidationError('That amount is unreasonably large.');
  }
}

function assertReason(reason: string, minLength = 3): void {
  if (reason.trim().length < minLength) {
    throw new ValidationError(`A reason of at least ${minLength} characters is required.`);
  }
  if (reason.length > 500) {
    throw new ValidationError('The reason is too long (500 characters maximum).');
  }
}

