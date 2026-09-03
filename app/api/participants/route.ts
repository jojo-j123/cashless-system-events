import { and, eq, ilike, or, sql } from 'drizzle-orm';
import { route } from '@/lib/api/handler';
import { ok } from '@/lib/api/responses';
import { accounts, eventParticipants, nfcCards, teamMembers, teams, users } from '@/lib/db/schema';

export const GET = route({ permission: 'participant.read.any' }, async ({ request, context }) => {
  const params = new URL(request.url).searchParams;
  const search = params.get('q')?.trim();
  const teamId = params.get('teamId');
  const limit = Math.min(Number(params.get('limit') ?? 50), 200);

  const conditions = [eq(eventParticipants.eventId, context.eventId)];
  if (teamId) conditions.push(eq(teamMembers.teamId, teamId));
  if (search) {
    const pattern = `%${search}%`;
    const match = or(
      ilike(users.displayName, pattern),
      ilike(users.email, pattern),
      ilike(users.phone, pattern),
      ilike(eventParticipants.participantRef, pattern),
      ilike(nfcCards.cardRef, pattern),
    );
    if (match) conditions.push(match);
  }

  const rows = await context.db
    .select({
      userId: users.id,
      displayName: users.displayName,
      email: users.email,
      avatarUrl: users.avatarUrl,
      status: users.status,
      participantRef: eventParticipants.participantRef,
      teamId: teams.id,
      teamName: teams.name,
      teamColor: teams.color,
      balance: accounts.balance,
      lifetimeEarned: accounts.lifetimeCredited,
      lifetimeSpent: accounts.lifetimeDebited,
      cardRef: nfcCards.cardRef,
      cardStatus: nfcCards.status,
    })
    .from(eventParticipants)
    .innerJoin(users, eq(users.id, eventParticipants.userId))
    .innerJoin(
      accounts,
      and(
        eq(accounts.ownerUserId, users.id),
        eq(accounts.eventId, context.eventId),
        eq(accounts.type, 'USER_SPENDABLE'),
      ),
    )
    .leftJoin(
      teamMembers,
      and(eq(teamMembers.userId, users.id), eq(teamMembers.eventId, context.eventId)),
    )
    .leftJoin(teams, eq(teams.id, teamMembers.teamId))
    .leftJoin(
      nfcCards,
      and(
        eq(nfcCards.assignedUserId, users.id),
        eq(nfcCards.eventId, context.eventId),
        sql`${nfcCards.status} = 'ACTIVE'`,
      ),
    )
    .where(and(...conditions))
    .orderBy(users.displayName)
    .limit(limit);

  return ok({ data: rows });
});
