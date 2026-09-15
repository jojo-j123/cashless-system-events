import { and, asc, eq, sql } from 'drizzle-orm';
import { isUniqueViolation, type Database, type Executor, type Transaction } from '../db/client';
import { challengeCompletions, challenges, teamMembers } from '../db/schema';
import type { challengeStatus } from '../db/schema';
import { recordAudit, type AuditContext } from '../audit';
import { withIdempotency } from '../core/idempotency';
import { getEventSettings } from '../settings/service';
import {
  ConflictError,
  FeatureDisabledError,
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

export type ChallengeStatus = (typeof challengeStatus.enumValues)[number];

/**
 * Challenges: do a thing, earn points.
 *
 * The security model is that the *amount* and the *award* are two different
 * permissions. Whoever sets a challenge up decides what it pays
 * (`challenge.write`); whoever marks it done only asserts that a person did it
 * (`challenge.award`). That is why an award does not go through the approval
 * thresholds a manual top-up does — the figure was already signed off when the
 * challenge was written, and asking for a second approval per completion would
 * make the feature unusable at an event without making it safer.
 */

export interface Challenge {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  rewardPoints: number;
  rewardScorePoints: number;
  maxCompletionsPerUser: number;
  status: ChallengeStatus;
  startsAt: Date | null;
  endsAt: Date | null;
  completions: number;
}

export interface ChallengeAwardResult {
  completionId: string;
  challengeId: string;
  userId: string;
  completionIndex: number;
  awardedPoints: number;
  awardedScorePoints: number;
  balanceAfter: number;
  txnRef: string | null;
}

/* -------------------------------------------------------------------------- */
/* Authoring                                                                  */
/* -------------------------------------------------------------------------- */

export async function createChallenge(
  db: Database,
  input: {
    eventId: string;
    name: string;
    slug: string;
    description?: string | null;
    rewardPoints: number;
    rewardScorePoints?: number;
    maxCompletionsPerUser?: number;
    startsAt?: Date | null;
    endsAt?: Date | null;
  },
  context: AuditContext,
): Promise<{ challengeId: string }> {
  await assertGameMode(db, input.eventId);
  assertSlug(input.slug);
  assertName(input.name);

  const rewardPoints = input.rewardPoints;
  const rewardScorePoints = input.rewardScorePoints ?? 0;
  assertRewardAmount(rewardPoints, 'rewardPoints');
  assertRewardAmount(rewardScorePoints, 'rewardScorePoints');

  // A challenge that pays nothing at all is almost certainly a mistake, and it
  // would sit in the list looking functional.
  if (rewardPoints === 0 && rewardScorePoints === 0) {
    throw new ValidationError('A challenge must award points, score, or both.');
  }

  const maxCompletionsPerUser = input.maxCompletionsPerUser ?? 1;
  if (!Number.isInteger(maxCompletionsPerUser) || maxCompletionsPerUser < 1) {
    throw new ValidationError('maxCompletionsPerUser must be a whole number of 1 or more.');
  }

  assertWindow(input.startsAt ?? null, input.endsAt ?? null);

  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: challenges.id })
      .from(challenges)
      .where(and(eq(challenges.eventId, input.eventId), eq(challenges.slug, input.slug)))
      .limit(1);
    if (existing.length > 0) {
      throw new ConflictError('A challenge with that slug already exists.', 'slug_taken');
    }

    const [challenge] = await tx
      .insert(challenges)
      .values({
        eventId: input.eventId,
        name: input.name,
        slug: input.slug,
        description: input.description ?? null,
        rewardPoints,
        rewardScorePoints,
        maxCompletionsPerUser,
        status: 'DRAFT',
        startsAt: input.startsAt ?? null,
        endsAt: input.endsAt ?? null,
      })
      .returning({ id: challenges.id });
    if (!challenge) throw new Error('Failed to create challenge');

    await recordAudit(tx, {
      ...context,
      eventId: input.eventId,
      action: 'challenge.created',
      targetType: 'challenge',
      targetId: challenge.id,
      after: { name: input.name, slug: input.slug, rewardPoints, rewardScorePoints },
    });

    return { challengeId: challenge.id };
  });
}

/**
 * Move a challenge between draft, active and ended.
 *
 * Ending is deliberately not deletion: completions reference the challenge with
 * ON DELETE RESTRICT, and the ledger entries they produced are permanent. A
 * challenge that paid out has to stay legible in the audit trail.
 */
export async function setChallengeStatus(
  db: Database,
  input: { eventId: string; challengeId: string; status: ChallengeStatus },
  context: AuditContext,
): Promise<void> {
  await assertGameMode(db, input.eventId);

  await db.transaction(async (tx) => {
    const challenge = await loadChallenge(tx, input.eventId, input.challengeId);

    if (challenge.status === input.status) return;
    if (challenge.status === 'ENDED') {
      throw new ConflictError('An ended challenge cannot be reopened.', 'challenge_ended');
    }

    await tx
      .update(challenges)
      .set({ status: input.status })
      .where(eq(challenges.id, input.challengeId));

    await recordAudit(tx, {
      ...context,
      eventId: input.eventId,
      action: 'challenge.status_changed',
      targetType: 'challenge',
      targetId: input.challengeId,
      before: { status: challenge.status },
      after: { status: input.status },
    });
  });
}

export async function listChallenges(db: Executor, eventId: string): Promise<Challenge[]> {
  const rows = await db
    .select({
      id: challenges.id,
      name: challenges.name,
      slug: challenges.slug,
      description: challenges.description,
      rewardPoints: challenges.rewardPoints,
      rewardScorePoints: challenges.rewardScorePoints,
      maxCompletionsPerUser: challenges.maxCompletionsPerUser,
      status: challenges.status,
      startsAt: challenges.startsAt,
      endsAt: challenges.endsAt,
      completions: sql<string>`count(${challengeCompletions.id})::text`,
    })
    .from(challenges)
    .leftJoin(challengeCompletions, eq(challengeCompletions.challengeId, challenges.id))
    .where(eq(challenges.eventId, eventId))
    .groupBy(challenges.id)
    .orderBy(asc(challenges.createdAt));

  return rows.map((row) => ({ ...row, completions: Number(row.completions ?? 0) }));
}

/* -------------------------------------------------------------------------- */
/* Awarding                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Mark a challenge complete for one participant and pay it out.
 *
 * Two separate ledger transactions, deliberately:
 *
 *   CHALLENGE_REWARD — spendable points, subject to the event's wallet cap.
 *   SCORE_AWARD      — score, which is not money and must not be capped by a
 *                      wallet limit.
 *
 * The score leg credits the participant's USER_SCORE *and* their team's
 * TEAM_SCORE, because the individual and team leaderboards read those two
 * different accounts. That is not double-counting: they are two boards asking
 * two questions, and issuance covers both legs so the event still sums to zero.
 */
export async function awardChallenge(
  db: Database,
  input: { eventId: string; challengeId: string; userId: string; awardedBy: string },
  idempotencyKey: string,
  context: AuditContext,
): Promise<{ result: ChallengeAwardResult; replayed: boolean }> {
  const settings = await getEventSettings(db, input.eventId);
  if (!settings.gameModeEnabled) {
    throw new FeatureDisabledError('challenges', 'This event is not running a game.');
  }
  await assertEventAcceptsPoints(db, input.eventId);

  const outcome = await withIdempotency<ChallengeAwardResult>(
    db,
    {
      scope: 'challenge.award',
      key: idempotencyKey,
      actorUserId: input.awardedBy,
      requestBody: {
        eventId: input.eventId,
        challengeId: input.challengeId,
        userId: input.userId,
      },
    },
    async (tx) => {
      const challenge = await loadChallenge(tx, input.eventId, input.challengeId);
      assertAwardable(challenge);

      const [tally] = await tx
        .select({ count: sql<string>`count(*)::text` })
        .from(challengeCompletions)
        .where(
          and(
            eq(challengeCompletions.challengeId, input.challengeId),
            eq(challengeCompletions.userId, input.userId),
          ),
        );

      const already = Number(tally?.count ?? 0);
      if (already >= challenge.maxCompletionsPerUser) {
        throw new ConflictError(
          challenge.maxCompletionsPerUser === 1
            ? 'That participant has already completed this challenge.'
            : `That participant has already completed this challenge ${already} times, which is the limit.`,
          'challenge_already_completed',
        );
      }

      // Claim the slot before any points move. Under a race both requests read
      // the same count and try the same index; the unique index on
      // (challenge, user, index) rejects the loser, so a one-shot challenge
      // cannot pay twice however the requests interleave.
      const completionIndex = already + 1;
      let completionId: string;
      try {
        const [completion] = await tx
          .insert(challengeCompletions)
          .values({
            eventId: input.eventId,
            challengeId: input.challengeId,
            userId: input.userId,
            completionIndex,
            awardedPoints: challenge.rewardPoints,
            verifiedBy: input.awardedBy,
          })
          .returning({ id: challengeCompletions.id });
        if (!completion) throw new Error('Failed to record challenge completion');
        completionId = completion.id;
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ConflictError(
            'That completion was just recorded by someone else.',
            'challenge_already_completed',
          );
        }
        throw error;
      }

      const issuanceId = await getSystemAccount(tx, input.eventId, 'SYSTEM_ISSUANCE');
      const walletId = await getUserAccount(tx, input.eventId, input.userId, 'USER_SPENDABLE');

      let txnRef: string | null = null;
      let rewardTransactionId: string | null = null;
      let balanceAfter = 0;

      if (challenge.rewardPoints > 0) {
        const posted = await postTransaction(tx, {
          eventId: input.eventId,
          type: 'CHALLENGE_REWARD',
          reason: `Challenge: ${challenge.name}`,
          referenceType: 'challenge_completion',
          referenceId: completionId,
          createdBy: input.awardedBy,
          maxHolderBalance: settings.maxWalletBalance,
          legs: [
            { accountId: issuanceId, amount: -challenge.rewardPoints },
            { accountId: walletId, amount: challenge.rewardPoints },
          ],
          metadata: { challengeSlug: challenge.slug, completionIndex },
        });
        txnRef = posted.txnRef;
        rewardTransactionId = posted.transactionId;
        balanceAfter = posted.balanceFor(walletId).after;
      } else {
        const [wallet] = await tx.execute<{ balance: string }>(
          sql`select balance::text as balance from accounts where id = ${walletId}`,
        ).then((result) => result.rows);
        balanceAfter = Number(wallet?.balance ?? 0);
      }

      if (challenge.rewardScorePoints > 0) {
        const scoreId = await getUserAccount(tx, input.eventId, input.userId, 'USER_SCORE');
        const legs: LedgerLeg[] = [{ accountId: scoreId, amount: challenge.rewardScorePoints }];

        const [membership] = await tx
          .select({ teamId: teamMembers.teamId })
          .from(teamMembers)
          .where(
            and(
              eq(teamMembers.eventId, input.eventId),
              eq(teamMembers.userId, input.userId),
            ),
          )
          .limit(1);

        if (membership) {
          const teamScoreId = await getTeamAccount(
            tx,
            input.eventId,
            membership.teamId,
            'TEAM_SCORE',
          );
          legs.push({ accountId: teamScoreId, amount: challenge.rewardScorePoints });
        }

        const issued = legs.reduce((sum, leg) => sum + leg.amount, 0);
        const posted = await postTransaction(tx, {
          eventId: input.eventId,
          type: 'SCORE_AWARD',
          reason: `Challenge score: ${challenge.name}`,
          referenceType: 'challenge_completion',
          referenceId: completionId,
          createdBy: input.awardedBy,
          // Deliberately uncapped: score is not spendable, so a wallet ceiling
          // has no meaning here and would silently stall a leaderboard.
          legs: [{ accountId: issuanceId, amount: -issued }, ...legs],
          metadata: { challengeSlug: challenge.slug, completionIndex },
        });
        txnRef ??= posted.txnRef;
        rewardTransactionId ??= posted.transactionId;
      }

      if (rewardTransactionId) {
        await tx
          .update(challengeCompletions)
          .set({ ledgerTransactionId: rewardTransactionId })
          .where(eq(challengeCompletions.id, completionId));
      }

      await recordAudit(tx, {
        ...context,
        eventId: input.eventId,
        action: 'challenge.awarded',
        targetType: 'user',
        targetId: input.userId,
        after: {
          challengeId: input.challengeId,
          challengeSlug: challenge.slug,
          completionIndex,
          awardedPoints: challenge.rewardPoints,
          awardedScorePoints: challenge.rewardScorePoints,
          balanceAfter,
        },
        metadata: { verifiedBy: input.awardedBy },
      });

      return {
        value: {
          completionId,
          challengeId: input.challengeId,
          userId: input.userId,
          completionIndex,
          awardedPoints: challenge.rewardPoints,
          awardedScorePoints: challenge.rewardScorePoints,
          balanceAfter,
          txnRef,
        },
        resourceType: 'challenge_completion',
        resourceId: completionId,
      };
    },
  );

  if (!outcome.replayed) {
    const { awardedPoints, awardedScorePoints } = outcome.value;
    await notify(db, {
      eventId: input.eventId,
      userId: input.userId,
      type: 'challenge.completed',
      title:
        awardedPoints > 0
          ? `+${awardedPoints.toLocaleString()} points`
          : `+${awardedScorePoints.toLocaleString()} score`,
      body: 'Challenge complete',
      severity: 'SUCCESS',
      data: {
        challengeId: input.challengeId,
        points: awardedPoints,
        score: awardedScorePoints,
      },
    });
  }

  return { result: outcome.value, replayed: outcome.replayed };
}

/* -------------------------------------------------------------------------- */
/* Guards                                                                     */
/* -------------------------------------------------------------------------- */

interface LoadedChallenge {
  id: string;
  name: string;
  slug: string;
  rewardPoints: number;
  rewardScorePoints: number;
  maxCompletionsPerUser: number;
  status: ChallengeStatus;
  startsAt: Date | null;
  endsAt: Date | null;
}

async function loadChallenge(
  tx: Transaction,
  eventId: string,
  challengeId: string,
): Promise<LoadedChallenge> {
  const [challenge] = await tx
    .select({
      id: challenges.id,
      name: challenges.name,
      slug: challenges.slug,
      rewardPoints: challenges.rewardPoints,
      rewardScorePoints: challenges.rewardScorePoints,
      maxCompletionsPerUser: challenges.maxCompletionsPerUser,
      status: challenges.status,
      startsAt: challenges.startsAt,
      endsAt: challenges.endsAt,
    })
    .from(challenges)
    .where(and(eq(challenges.id, challengeId), eq(challenges.eventId, eventId)))
    .limit(1);

  // Scoped by event as well as id, so a challenge id from another event reads
  // as missing rather than as someone else's challenge.
  if (!challenge) throw new NotFoundError('That challenge');
  return challenge;
}

function assertAwardable(challenge: LoadedChallenge): void {
  if (challenge.status !== 'ACTIVE') {
    throw new ConflictError(
      challenge.status === 'DRAFT'
        ? 'That challenge is still a draft.'
        : 'That challenge has ended.',
      'challenge_not_active',
    );
  }

  const now = Date.now();
  if (challenge.startsAt && challenge.startsAt.getTime() > now) {
    throw new ConflictError('That challenge has not opened yet.', 'challenge_not_open');
  }
  if (challenge.endsAt && challenge.endsAt.getTime() <= now) {
    throw new ConflictError('That challenge has closed.', 'challenge_closed');
  }
}

async function assertGameMode(db: Executor, eventId: string): Promise<void> {
  const settings = await getEventSettings(db, eventId);
  if (!settings.gameModeEnabled) {
    throw new FeatureDisabledError('challenges', 'This event is not running a game.');
  }
}

function assertSlug(slug: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new ValidationError('Slug must be lowercase letters, numbers and single hyphens.');
  }
}

function assertName(name: string): void {
  if (name.trim().length < 2) {
    throw new ValidationError('A challenge needs a name of at least 2 characters.');
  }
  if (name.length > 200) {
    throw new ValidationError('That name is too long (200 characters maximum).');
  }
}

function assertRewardAmount(amount: number, field: string): void {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new ValidationError(`${field} must be a whole number of zero or more.`);
  }
  if (amount > 100_000_000) {
    throw new ValidationError(`${field} is unreasonably large.`);
  }
}

function assertWindow(startsAt: Date | null, endsAt: Date | null): void {
  if (startsAt && endsAt && startsAt.getTime() >= endsAt.getTime()) {
    throw new ValidationError('A challenge cannot close before it opens.');
  }
}
