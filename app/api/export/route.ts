import { and, desc, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { route } from '@/lib/api/handler';
import {
  accounts,
  eventParticipants,
  ledgerEntries,
  ledgerTransactions,
  purchases,
  stores,
  teams,
  teamMembers,
  users,
} from '@/lib/db/schema';
import { listStock } from '@/lib/services/inventory';
import { getSalesByStore, getTeamLeaderboard, toCsv } from '@/lib/services/reports';
import { ValidationError } from '@/lib/errors';

const DATASETS = ['transactions', 'purchases', 'participants', 'inventory', 'teams', 'sales'] as const;
type Dataset = (typeof DATASETS)[number];

export const GET = route({ permission: 'report.export' }, async ({ request, context }) => {
  const dataset = new URL(request.url).searchParams.get('dataset') as Dataset | null;
  if (!dataset || !DATASETS.includes(dataset)) {
    throw new ValidationError(`dataset must be one of: ${DATASETS.join(', ')}`);
  }

  const rows = await loadDataset(context.db, context.eventId, dataset);
  const csv = toCsv(rows);
  const filename = `${dataset}-${new Date().toISOString().slice(0, 10)}.csv`;

  return new NextResponse(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    },
  });
});

async function loadDataset(
  db: Parameters<typeof listStock>[0],
  eventId: string,
  dataset: Dataset,
): Promise<Record<string, unknown>[]> {
  switch (dataset) {
    case 'transactions': {
      const rows = await db
        .select({
          txnRef: ledgerTransactions.txnRef,
          type: ledgerTransactions.type,
          amount: ledgerEntries.amount,
          balanceAfter: ledgerEntries.balanceAfter,
          accountName: accounts.name,
          accountType: accounts.type,
          reason: ledgerTransactions.reason,
          createdAt: ledgerTransactions.createdAt,
        })
        .from(ledgerEntries)
        .innerJoin(ledgerTransactions, eq(ledgerTransactions.id, ledgerEntries.transactionId))
        .innerJoin(accounts, eq(accounts.id, ledgerEntries.accountId))
        .where(eq(ledgerEntries.eventId, eventId))
        .orderBy(desc(ledgerTransactions.createdAt))
        .limit(50_000);
      return rows;
    }
    case 'purchases': {
      const rows = await db
        .select({
          purchaseRef: purchases.purchaseRef,
          status: purchases.status,
          storeName: stores.name,
          participant: users.displayName,
          totalPoints: purchases.totalPoints,
          refundedPoints: purchases.refundedPoints,
          createdAt: purchases.createdAt,
        })
        .from(purchases)
        .innerJoin(stores, eq(stores.id, purchases.storeId))
        .innerJoin(users, eq(users.id, purchases.userId))
        .where(eq(purchases.eventId, eventId))
        .orderBy(desc(purchases.createdAt))
        .limit(50_000);
      return rows;
    }
    case 'participants': {
      const rows = await db
        .select({
          participantRef: eventParticipants.participantRef,
          displayName: users.displayName,
          email: users.email,
          team: teams.name,
          balance: accounts.balance,
          lifetimeEarned: accounts.lifetimeCredited,
          lifetimeSpent: accounts.lifetimeDebited,
        })
        .from(eventParticipants)
        .innerJoin(users, eq(users.id, eventParticipants.userId))
        .innerJoin(
          accounts,
          and(
            eq(accounts.ownerUserId, users.id),
            eq(accounts.eventId, eventId),
            eq(accounts.type, 'USER_SPENDABLE'),
          ),
        )
        .leftJoin(
          teamMembers,
          and(eq(teamMembers.userId, users.id), eq(teamMembers.eventId, eventId)),
        )
        .leftJoin(teams, eq(teams.id, teamMembers.teamId))
        .where(eq(eventParticipants.eventId, eventId))
        .orderBy(users.displayName);
      return rows;
    }
    case 'inventory':
      return (await listStock(db, eventId)) as unknown as Record<string, unknown>[];
    case 'teams':
      return (await getTeamLeaderboard(db, eventId)) as unknown as Record<string, unknown>[];
    case 'sales':
      return (await getSalesByStore(db, eventId)) as unknown as Record<string, unknown>[];
    default: {
      const exhaustive: never = dataset;
      return exhaustive;
    }
  }
}
