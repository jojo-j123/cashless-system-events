import { and, desc, eq } from 'drizzle-orm';
import { requireSession } from '@/lib/auth/server';
import { approvalRequests, teams, topups, users } from '@/lib/db/schema';
import { getEventSettings } from '@/lib/settings/service';
import { TopUpCounter } from '@/components/admin/TopUpCounter';

export const metadata = { title: 'Points · Admin' };
export const dynamic = 'force-dynamic';

export default async function PointsPage(): Promise<React.ReactElement> {
  const session = await requireSession('wallet.topup');

  const [settings, teamRows, recent, pendingApprovals] = await Promise.all([
    getEventSettings(session.db, session.eventId),
    session.db
      .select({ id: teams.id, name: teams.name, color: teams.color })
      .from(teams)
      .where(eq(teams.eventId, session.eventId))
      .orderBy(teams.name),
    session.db
      .select({
        id: topups.id,
        topupRef: topups.topupRef,
        amountPoints: topups.amountPoints,
        reason: topups.reason,
        targetType: topups.targetType,
        createdAt: topups.createdAt,
        recipientName: users.displayName,
        teamName: teams.name,
      })
      .from(topups)
      .leftJoin(users, eq(users.id, topups.userId))
      .leftJoin(teams, eq(teams.id, topups.teamId))
      .where(eq(topups.eventId, session.eventId))
      .orderBy(desc(topups.createdAt))
      .limit(15),
    session.db
      .select({
        id: approvalRequests.id,
        type: approvalRequests.type,
        amountPoints: approvalRequests.amountPoints,
        reason: approvalRequests.reason,
        createdAt: approvalRequests.createdAt,
        requestedBy: approvalRequests.requestedBy,
        requesterName: users.displayName,
      })
      .from(approvalRequests)
      .innerJoin(users, eq(users.id, approvalRequests.requestedBy))
      .where(
        and(
          eq(approvalRequests.eventId, session.eventId),
          eq(approvalRequests.status, 'PENDING_APPROVAL'),
        ),
      )
      .orderBy(desc(approvalRequests.createdAt))
      .limit(20),
  ]);

  return (
    <TopUpCounter
      teams={teamRows}
      recentTopUps={recent.map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
      }))}
      approvals={pendingApprovals.map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
        isOwnRequest: row.requestedBy === session.actor.userId,
      }))}
      canApprove={session.actor.can('approval.decide', { eventId: session.eventId })}
      canAllocate={session.actor.can('team.allocate', { eventId: session.eventId })}
      canAdjust={session.actor.can('wallet.adjust', { eventId: session.eventId })}
      settings={{
        maxSingleTopUp: settings.maxSingleTopUp,
        pinRequiredAboveTopUp: settings.pinRequiredAboveTopUp,
        approvalThresholdTopUp: settings.approvalThresholdTopUp,
      }}
    />
  );
}
