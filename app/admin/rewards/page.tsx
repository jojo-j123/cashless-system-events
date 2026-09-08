import { asc, eq, inArray } from 'drizzle-orm';
import { requireSession } from '@/lib/auth/server';
import { listRedemptions, listRewards } from '@/lib/services/rewards';
import { eventParticipants, users } from '@/lib/db/schema';
import { RewardDesk } from '@/components/admin/RewardDesk';

export const metadata = { title: 'Rewards · Admin' };
export const dynamic = 'force-dynamic';

/**
 * The rewards desk.
 *
 * Not gated on game mode: challenges create points and belong to a game, but
 * rewards only spend them, and a plain cashless event has just as much use for
 * "200 points gets you a queue skip".
 */
export default async function RewardsPage(): Promise<React.ReactElement> {
  const session = await requireSession('reward.read');

  const [rewards, claims, people] = await Promise.all([
    listRewards(session.db, session.eventId),
    listRedemptions(session.db, session.eventId, { limit: 200 }),
    session.db
      .select({ id: users.id, displayName: users.displayName })
      .from(eventParticipants)
      .innerJoin(users, eq(users.id, eventParticipants.userId))
      .where(eq(eventParticipants.eventId, session.eventId))
      .orderBy(asc(users.displayName)),
  ]);

  // Claim rows carry a user id; the desk needs a name against each one.
  const claimantIds = [...new Set(claims.map((claim) => claim.userId))];
  const claimants =
    claimantIds.length > 0
      ? await session.db
          .select({ id: users.id, displayName: users.displayName })
          .from(users)
          .where(inArray(users.id, claimantIds))
      : [];
  const nameById = new Map(claimants.map((person) => [person.id, person.displayName]));

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-ink-900">Rewards</h1>
        <p className="text-sm text-ink-500">
          Spend points on something that is not a till purchase.
        </p>
      </header>

      <RewardDesk
        rewards={rewards.map((reward) => ({
          id: reward.id,
          name: reward.name,
          description: reward.description,
          costPoints: reward.costPoints,
          stock: reward.stock,
          isActive: reward.isActive,
          redeemed: reward.redeemed,
        }))}
        claims={claims.map((claim) => ({
          id: claim.id,
          rewardName: claim.rewardName,
          participantName: nameById.get(claim.userId) ?? 'Unknown',
          costPoints: claim.costPoints,
          status: claim.status,
          createdAt: claim.createdAt.toISOString(),
        }))}
        people={people}
        canWrite={session.actor.can('reward.write', { eventId: session.eventId })}
        canFulfil={session.actor.can('reward.fulfil', { eventId: session.eventId })}
        canRedeemForOthers={session.actor.can('reward.redeem.any', { eventId: session.eventId })}
      />
    </div>
  );
}
