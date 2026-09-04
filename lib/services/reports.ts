import { sql } from 'drizzle-orm';
import type { Executor } from '../db/client';

export interface DateRange {
  from?: Date | null;
  to?: Date | null;
}

function range(dates: DateRange) {
  return {
    from: dates.from ? dates.from.toISOString() : null,
    to: dates.to ? dates.to.toISOString() : null,
  };
}

export interface EventOverview {
  participants: number;
  activeCards: number;
  unassignedCards: number;
  suspendedCards: number;
  pointsIssued: number;
  pointsInCirculation: number;
  pointsSpent: number;
  pointsRefunded: number;
  purchasesToday: number;
  spentToday: number;
  activeStores: number;
  lowStockProducts: number;
  averageBasket: number;
}

/**
 * Headline numbers for the admin dashboard.
 *
 * `pointsIssued` and `pointsInCirculation` are read off ledger account
 * balances rather than summed from transaction rows: the issuance account IS
 * the total ever minted, so the figure is exact by construction and cannot
 * drift from double counting.
 */
export async function getEventOverview(
  db: Executor,
  eventId: string,
): Promise<EventOverview> {
  const result = await db.execute<Record<string, string>>(sql`
    select
      (select count(*) from event_participants where event_id = ${eventId})            as participants,
      (select count(*) from nfc_cards where event_id = ${eventId} and status = 'ACTIVE')      as active_cards,
      (select count(*) from nfc_cards where event_id = ${eventId} and status = 'UNASSIGNED')  as unassigned_cards,
      (select count(*) from nfc_cards where event_id = ${eventId}
         and status in ('SUSPENDED', 'LOST'))                                          as suspended_cards,
      (select coalesce(-sum(balance), 0) from accounts
        where event_id = ${eventId} and type = 'SYSTEM_ISSUANCE')                      as points_issued,
      (select coalesce(sum(balance), 0) from accounts
        where event_id = ${eventId} and type in ('USER_SPENDABLE', 'TEAM_SPENDABLE'))  as points_in_circulation,
      (select coalesce(sum(balance), 0) from accounts
        where event_id = ${eventId} and type = 'SYSTEM_STORE_REVENUE')                 as points_spent,
      (select coalesce(sum(amount_points), 0) from refunds
        where event_id = ${eventId} and status = 'COMPLETED')                          as points_refunded,
      (select count(*) from purchases
        where event_id = ${eventId} and status in ('COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED')
          and created_at >= date_trunc('day', now()))                                  as purchases_today,
      (select coalesce(sum(total_points), 0) from purchases
        where event_id = ${eventId} and status in ('COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED')
          and created_at >= date_trunc('day', now()))                                  as spent_today,
      (select count(*) from stores
        where event_id = ${eventId} and is_active and deleted_at is null)               as active_stores,
      (select count(*) from inventory
        where event_id = ${eventId} and track_inventory
          and quantity_on_hand <= low_stock_threshold)                                  as low_stock_products,
      (select coalesce(round(avg(total_points)), 0) from purchases
        where event_id = ${eventId} and status <> 'FAILED')                             as average_basket
  `);

  const row = result.rows[0] ?? {};
  const num = (key: string): number => Number(row[key] ?? 0);

  return {
    participants: num('participants'),
    activeCards: num('active_cards'),
    unassignedCards: num('unassigned_cards'),
    suspendedCards: num('suspended_cards'),
    pointsIssued: num('points_issued'),
    pointsInCirculation: num('points_in_circulation'),
    pointsSpent: num('points_spent'),
    pointsRefunded: num('points_refunded'),
    purchasesToday: num('purchases_today'),
    spentToday: num('spent_today'),
    activeStores: num('active_stores'),
    lowStockProducts: num('low_stock_products'),
    averageBasket: num('average_basket'),
  };
}

export interface TimeSeriesPoint {
  bucket: string;
  issued: number;
  spent: number;
  purchases: number;
}

/** Points issued and spent per hour — the shape of the event's trading day. */
export async function getPointsTimeSeries(
  db: Executor,
  eventId: string,
  dates: DateRange = {},
): Promise<TimeSeriesPoint[]> {
  const { from, to } = range(dates);
  const result = await db.execute<Record<string, string>>(sql`
    with buckets as (
      select date_trunc('hour', created_at) as bucket,
             sum(case when type in ('TOP_UP', 'TEAM_ALLOCATION', 'BONUS', 'CHALLENGE_REWARD')
                      then 1 else 0 end) as issue_count
        from ledger_transactions
       where event_id = ${eventId}
         and (${from}::timestamptz is null or created_at >= ${from}::timestamptz)
         and (${to}::timestamptz is null or created_at <= ${to}::timestamptz)
       group by 1
    ),
    issued as (
      select date_trunc('hour', t.created_at) as bucket, coalesce(sum(e.amount), 0) as total
        from ledger_transactions t
        join ledger_entries e on e.transaction_id = t.id
        join accounts a on a.id = e.account_id
       where t.event_id = ${eventId}
         and a.type in ('USER_SPENDABLE', 'TEAM_SPENDABLE')
         and e.amount > 0
         and t.type in ('TOP_UP', 'TEAM_ALLOCATION', 'BONUS', 'CHALLENGE_REWARD', 'MANUAL_ADJUSTMENT')
       group by 1
    ),
    spent as (
      select date_trunc('hour', created_at) as bucket,
             coalesce(sum(total_points), 0) as total,
             count(*) as purchases
        from purchases
       where event_id = ${eventId} and status <> 'FAILED'
       group by 1
    )
    select to_char(coalesce(i.bucket, s.bucket, b.bucket), 'YYYY-MM-DD"T"HH24:00:00Z') as bucket,
           coalesce(i.total, 0)::text     as issued,
           coalesce(s.total, 0)::text     as spent,
           coalesce(s.purchases, 0)::text as purchases
      from buckets b
      full outer join issued i on i.bucket = b.bucket
      full outer join spent s  on s.bucket = coalesce(i.bucket, b.bucket)
     order by 1
  `);

  return result.rows.map((row) => ({
    bucket: String(row.bucket ?? ''),
    issued: Number(row.issued ?? 0),
    spent: Number(row.spent ?? 0),
    purchases: Number(row.purchases ?? 0),
  }));
}

export interface StoreSales {
  storeId: string;
  storeName: string;
  purchases: number;
  grossPoints: number;
  refundedPoints: number;
  netPoints: number;
  averageBasket: number;
}

export async function getSalesByStore(
  db: Executor,
  eventId: string,
  dates: DateRange = {},
): Promise<StoreSales[]> {
  const { from, to } = range(dates);
  const result = await db.execute<Record<string, string>>(sql`
    select s.id                                        as store_id,
           s.name                                      as store_name,
           count(p.id)::text                           as purchases,
           coalesce(sum(p.total_points), 0)::text      as gross_points,
           coalesce(sum(p.refunded_points), 0)::text   as refunded_points,
           coalesce(round(avg(p.total_points)), 0)::text as average_basket
      from stores s
      left join purchases p
        on p.store_id = s.id
       and p.status <> 'FAILED'
       and (${from}::timestamptz is null or p.created_at >= ${from}::timestamptz)
       and (${to}::timestamptz is null or p.created_at <= ${to}::timestamptz)
     where s.event_id = ${eventId} and s.deleted_at is null
     group by s.id, s.name
     order by coalesce(sum(p.total_points), 0) desc
  `);

  return result.rows.map((row) => {
    const gross = Number(row.gross_points ?? 0);
    const refunded = Number(row.refunded_points ?? 0);
    return {
      storeId: String(row.store_id),
      storeName: String(row.store_name),
      purchases: Number(row.purchases ?? 0),
      grossPoints: gross,
      refundedPoints: refunded,
      netPoints: gross - refunded,
      averageBasket: Number(row.average_basket ?? 0),
    };
  });
}

export interface ProductSales {
  productId: string;
  name: string;
  sku: string;
  storeName: string;
  unitsSold: number;
  unitsRefunded: number;
  grossPoints: number;
}

export async function getTopProducts(
  db: Executor,
  eventId: string,
  options: DateRange & { limit?: number; storeId?: string } = {},
): Promise<ProductSales[]> {
  const { from, to } = range(options);
  const result = await db.execute<Record<string, string>>(sql`
    select pi.product_id                                   as product_id,
           max(pi.name_snapshot)                           as name,
           max(pi.sku_snapshot)                            as sku,
           max(s.name)                                     as store_name,
           coalesce(sum(pi.quantity), 0)::text             as units_sold,
           coalesce(sum(pi.refunded_quantity), 0)::text    as units_refunded,
           coalesce(sum(pi.line_total_points), 0)::text    as gross_points
      from purchase_items pi
      join purchases p on p.id = pi.purchase_id
      join stores s on s.id = p.store_id
     where p.event_id = ${eventId}
       and p.status <> 'FAILED'
       and (${options.storeId ?? null}::uuid is null or p.store_id = ${options.storeId ?? null}::uuid)
       and (${from}::timestamptz is null or p.created_at >= ${from}::timestamptz)
       and (${to}::timestamptz is null or p.created_at <= ${to}::timestamptz)
     group by pi.product_id
     order by coalesce(sum(pi.quantity), 0) desc
     limit ${Math.min(options.limit ?? 20, 100)}
  `);

  return result.rows.map((row) => ({
    productId: String(row.product_id),
    name: String(row.name),
    sku: String(row.sku),
    storeName: String(row.store_name),
    unitsSold: Number(row.units_sold ?? 0),
    unitsRefunded: Number(row.units_refunded ?? 0),
    grossPoints: Number(row.gross_points ?? 0),
  }));
}

export interface TeamStanding {
  teamId: string;
  name: string;
  color: string;
  members: number;
  score: number;
  walletBalance: number;
  totalEarned: number;
  totalSpent: number;
  rank: number;
}

export type TeamMetric = 'TEAM_SCORE' | 'TOTAL_EARNED' | 'TOTAL_SPENT' | 'CURRENT_BALANCE';

/**
 * Team leaderboard.
 *
 * The ranking metric is configurable because "winning" means different things
 * at different events: a competition scored by challenges is not the same as
 * one scored by how much the team spent.
 */
export async function getTeamLeaderboard(
  db: Executor,
  eventId: string,
  metric: TeamMetric = 'TEAM_SCORE',
): Promise<TeamStanding[]> {
  const result = await db.execute<Record<string, string>>(sql`
    select t.id                                       as team_id,
           t.name                                     as name,
           t.color                                    as color,
           count(distinct tm.user_id)::text           as members,
           coalesce(score.balance, 0)::text           as score,
           coalesce(wallet.balance, 0)::text          as wallet_balance,
           coalesce(sum(member.lifetime_credited), 0)::text as total_earned,
           coalesce(sum(member.lifetime_debited), 0)::text  as total_spent
      from teams t
      left join team_members tm on tm.team_id = t.id
      left join accounts member
        on member.owner_user_id = tm.user_id
       and member.event_id = ${eventId}
       and member.type = 'USER_SPENDABLE'
      left join accounts score
        on score.owner_team_id = t.id and score.type = 'TEAM_SCORE'
      left join accounts wallet
        on wallet.owner_team_id = t.id and wallet.type = 'TEAM_SPENDABLE'
     where t.event_id = ${eventId} and t.deleted_at is null
     group by t.id, t.name, t.color, score.balance, wallet.balance
  `);

  const standings = result.rows.map((row) => ({
    teamId: String(row.team_id),
    name: String(row.name),
    color: String(row.color),
    members: Number(row.members ?? 0),
    score: Number(row.score ?? 0),
    walletBalance: Number(row.wallet_balance ?? 0),
    totalEarned: Number(row.total_earned ?? 0),
    totalSpent: Number(row.total_spent ?? 0),
    rank: 0,
  }));

  const key = (standing: (typeof standings)[number]): number => {
    switch (metric) {
      case 'TOTAL_EARNED':
        return standing.totalEarned;
      case 'TOTAL_SPENT':
        return standing.totalSpent;
      case 'CURRENT_BALANCE':
        return standing.walletBalance;
      case 'TEAM_SCORE':
      default:
        return standing.score;
    }
  };

  standings.sort((a, b) => key(b) - key(a));
  standings.forEach((standing, index) => {
    standing.rank = index + 1;
  });
  return standings;
}

export interface IndividualStanding {
  userId: string;
  displayName: string;
  teamName: string | null;
  balance: number;
  totalEarned: number;
  totalSpent: number;
  scorePoints: number;
  rank: number;
}

export type IndividualMetric =
  | 'TOTAL_EARNED'
  | 'TOTAL_SPENT'
  | 'CHALLENGE_POINTS'
  | 'CURRENT_BALANCE';

export async function getIndividualLeaderboard(
  db: Executor,
  eventId: string,
  metric: IndividualMetric = 'TOTAL_EARNED',
  limit = 50,
): Promise<IndividualStanding[]> {
  const column =
    metric === 'TOTAL_SPENT'
      ? sql`w.lifetime_debited`
      : metric === 'CURRENT_BALANCE'
        ? sql`w.balance`
        : metric === 'CHALLENGE_POINTS'
          ? sql`coalesce(sc.balance, 0)`
          : sql`w.lifetime_credited`;

  const result = await db.execute<Record<string, string>>(sql`
    select u.id                              as user_id,
           u.display_name                    as display_name,
           t.name                            as team_name,
           w.balance::text                   as balance,
           w.lifetime_credited::text         as total_earned,
           w.lifetime_debited::text          as total_spent,
           coalesce(sc.balance, 0)::text     as score_points
      from accounts w
      join users u on u.id = w.owner_user_id
      left join team_members tm on tm.user_id = u.id and tm.event_id = ${eventId}
      left join teams t on t.id = tm.team_id
      left join accounts sc
        on sc.owner_user_id = u.id and sc.event_id = ${eventId} and sc.type = 'USER_SCORE'
     where w.event_id = ${eventId} and w.type = 'USER_SPENDABLE'
     order by ${column} desc, u.display_name asc
     limit ${Math.min(limit, 200)}
  `);

  return result.rows.map((row, index) => ({
    userId: String(row.user_id),
    displayName: String(row.display_name),
    teamName: row.team_name === null || row.team_name === undefined ? null : String(row.team_name),
    balance: Number(row.balance ?? 0),
    totalEarned: Number(row.total_earned ?? 0),
    totalSpent: Number(row.total_spent ?? 0),
    scorePoints: Number(row.score_points ?? 0),
    rank: index + 1,
  }));
}

export interface OpsSnapshot {
  storesOnline: number;
  storesTotal: number;
  terminalsOnline: number;
  terminalsTotal: number;
  terminalsError: number;
  transactionsLastMinute: number;
  transactionsLastHour: number;
  failedTransactionsLastHour: number;
  cardsSuspended: number;
  lowStockCount: number;
  ledgerBalanced: boolean;
  ledgerDrift: number;
}

/**
 * The live operations view. Answers "is anything wrong right now?" — the only
 * question that matters at 8pm on the busiest night of the event.
 */
export async function getOpsSnapshot(db: Executor, eventId: string): Promise<OpsSnapshot> {
  const result = await db.execute<Record<string, string>>(sql`
    select
      (select count(*) from stores where event_id = ${eventId} and is_active and is_open
         and deleted_at is null)                                                as stores_online,
      (select count(*) from stores where event_id = ${eventId} and deleted_at is null) as stores_total,
      (select count(*) from terminals where event_id = ${eventId}
         and not is_disabled and last_heartbeat_at > now() - interval '2 minutes') as terminals_online,
      (select count(*) from terminals where event_id = ${eventId})               as terminals_total,
      (select count(*) from terminals where event_id = ${eventId} and is_disabled) as terminals_error,
      (select count(*) from purchases where event_id = ${eventId}
         and created_at > now() - interval '1 minute')                          as txn_last_minute,
      (select count(*) from purchases where event_id = ${eventId}
         and created_at > now() - interval '1 hour')                            as txn_last_hour,
      (select count(*) from purchases where event_id = ${eventId}
         and status = 'FAILED' and created_at > now() - interval '1 hour')      as failed_last_hour,
      (select count(*) from nfc_cards where event_id = ${eventId}
         and status in ('SUSPENDED', 'LOST'))                                   as cards_suspended,
      (select count(*) from inventory where event_id = ${eventId}
         and track_inventory and quantity_on_hand <= low_stock_threshold)       as low_stock,
      (select coalesce(sum(balance), 0) from accounts where event_id = ${eventId}) as ledger_sum,
      (select count(*) from account_reconciliation
        where event_id = ${eventId} and drift <> 0)                             as drifting
  `);

  const row = result.rows[0] ?? {};
  const num = (key: string): number => Number(row[key] ?? 0);
  const ledgerSum = num('ledger_sum');
  const drifting = num('drifting');

  return {
    storesOnline: num('stores_online'),
    storesTotal: num('stores_total'),
    terminalsOnline: num('terminals_online'),
    terminalsTotal: num('terminals_total'),
    terminalsError: num('terminals_error'),
    transactionsLastMinute: num('txn_last_minute'),
    transactionsLastHour: num('txn_last_hour'),
    failedTransactionsLastHour: num('failed_last_hour'),
    cardsSuspended: num('cards_suspended'),
    lowStockCount: num('low_stock'),
    ledgerBalanced: ledgerSum === 0 && drifting === 0,
    ledgerDrift: drifting,
  };
}

/** CSV export. Values are quoted and escaped so a name with a comma is safe. */
export function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0] as Record<string, unknown>);
  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    const text = value instanceof Date ? value.toISOString() : String(value);
    // Leading =, +, - or @ makes a spreadsheet treat the cell as a formula.
    const guarded = /^[=+\-@]/.test(text) ? `'${text}` : text;
    return `"${guarded.replace(/"/g, '""')}"`;
  };
  return [
    headers.map(escape).join(','),
    ...rows.map((row) => headers.map((header) => escape(row[header])).join(',')),
  ].join('\n');
}
