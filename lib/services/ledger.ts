import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Executor, Transaction } from '../db/client';
import { accounts, events, ledgerEntries, ledgerTransactions } from '../db/schema';
import type { accountType, ledgerTransactionType } from '../db/schema';
import { nextRef } from '../core/refs';
import {
  EventNotOperationalError,
  InsufficientFundsError,
  LimitExceededError,
  NotFoundError,
  WalletFrozenError,
} from '../errors';

export type AccountType = (typeof accountType.enumValues)[number];
export type LedgerTransactionType = (typeof ledgerTransactionType.enumValues)[number];

/** One side of a transaction. Positive credits the account, negative debits it. */
export interface LedgerLeg {
  accountId: string;
  amount: number;
}

export interface PostTransactionInput {
  eventId: string;
  type: LedgerTransactionType;
  reason: string;
  legs: LedgerLeg[];
  referenceType?: string | null;
  referenceId?: string | null;
  reversesTransactionId?: string | null;
  idempotencyKey?: string | null;
  createdBy?: string | null;
  metadata?: Record<string, unknown>;
  /** Cap applied to holder accounts being credited. Skipped for system accounts. */
  maxHolderBalance?: number;
}

export interface PostedBalance {
  accountId: string;
  before: number;
  after: number;
  delta: number;
}

export interface PostedTransaction {
  transactionId: string;
  txnRef: string;
  balances: PostedBalance[];
  balanceFor: (accountId: string) => PostedBalance;
}

const HOLDER_TYPES: ReadonlySet<AccountType> = new Set<AccountType>([
  'USER_SPENDABLE',
  'USER_SCORE',
  'TEAM_SPENDABLE',
  'TEAM_SCORE',
]);

/**
 * Post a balanced transaction to the ledger. This is the ONLY way points move.
 *
 * Must be called inside a transaction. Accounts are locked FOR UPDATE in
 * ascending id order — a fixed global order that makes deadlock between two
 * concurrent postings structurally impossible.
 *
 * The caller supplies legs; this function computes before/after balances from
 * the locked rows, so a stale balance read by the caller cannot produce a
 * wrong entry.
 */
export async function postTransaction(
  tx: Transaction,
  input: PostTransactionInput,
): Promise<PostedTransaction> {
  const merged = mergeLegs(input.legs);

  if (merged.length < 2) {
    throw new Error('A ledger transaction needs at least two legs (double-entry).');
  }
  const total = merged.reduce((sum, leg) => sum + leg.amount, 0);
  if (total !== 0) {
    throw new Error(`Ledger transaction does not balance: legs sum to ${total}, expected 0.`);
  }
  for (const leg of merged) {
    if (!Number.isSafeInteger(leg.amount)) {
      throw new Error(`Ledger amounts must be safe integers, got ${leg.amount}.`);
    }
  }

  const lockedAccounts = await lockAccounts(
    tx,
    merged.map((leg) => leg.accountId),
    input.eventId,
  );

  // Validate every leg against the freshly locked state before writing anything.
  const balances: PostedBalance[] = [];
  for (const leg of merged) {
    const account = lockedAccounts.get(leg.accountId);
    if (!account) throw new NotFoundError('The wallet');

    if (account.status !== 'ACTIVE') {
      throw new WalletFrozenError();
    }

    const before = account.balance;
    const after = before + leg.amount;

    if (after < 0 && !account.allowNegative) {
      throw new InsufficientFundsError(before, Math.abs(leg.amount));
    }

    if (
      input.maxHolderBalance !== undefined &&
      leg.amount > 0 &&
      HOLDER_TYPES.has(account.type) &&
      after > input.maxHolderBalance
    ) {
      throw new LimitExceededError(
        'maxWalletBalance',
        input.maxHolderBalance,
        after,
        `That would take the balance to ${after.toLocaleString()} points, above the ${input.maxHolderBalance.toLocaleString()} limit.`,
      );
    }

    balances.push({ accountId: leg.accountId, before, after, delta: leg.amount });
  }

  const txnRef = await nextRef(tx, 'ledgerTransaction');

  const [header] = await tx
    .insert(ledgerTransactions)
    .values({
      eventId: input.eventId,
      txnRef,
      type: input.type,
      reason: input.reason,
      referenceType: input.referenceType ?? null,
      referenceId: input.referenceId ?? null,
      reversesTransactionId: input.reversesTransactionId ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      createdBy: input.createdBy ?? null,
      metadata: input.metadata ?? {},
    })
    .returning({ id: ledgerTransactions.id });

  if (!header) throw new Error('Failed to create ledger transaction');

  await tx.insert(ledgerEntries).values(
    balances.map((balance) => ({
      eventId: input.eventId,
      transactionId: header.id,
      accountId: balance.accountId,
      amount: balance.delta,
      balanceBefore: balance.before,
      balanceAfter: balance.after,
    })),
  );

  // Update the materialised balances. The DB check constraint and the deferred
  // balanced-transaction trigger both re-verify this at COMMIT.
  for (const balance of balances) {
    await tx
      .update(accounts)
      .set({
        balance: balance.after,
        lifetimeCredited:
          balance.delta > 0
            ? sql`${accounts.lifetimeCredited} + ${balance.delta}`
            : accounts.lifetimeCredited,
        lifetimeDebited:
          balance.delta < 0
            ? sql`${accounts.lifetimeDebited} + ${Math.abs(balance.delta)}`
            : accounts.lifetimeDebited,
      })
      .where(eq(accounts.id, balance.accountId));
  }

  const byAccount = new Map(balances.map((balance) => [balance.accountId, balance]));
  return {
    transactionId: header.id,
    txnRef,
    balances,
    balanceFor(accountId: string): PostedBalance {
      const found = byAccount.get(accountId);
      if (!found) throw new Error(`Account ${accountId} was not part of this transaction.`);
      return found;
    },
  };
}

type LockedAccount = {
  id: string;
  type: AccountType;
  balance: number;
  allowNegative: boolean;
  status: 'ACTIVE' | 'FROZEN' | 'CLOSED';
};

/**
 * Lock accounts for update in ascending id order.
 *
 * The ORDER BY is the deadlock-avoidance mechanism, not a nicety: two
 * transactions touching the same pair of wallets always take the locks in the
 * same sequence, so neither can hold what the other needs.
 */
export async function lockAccounts(
  tx: Transaction,
  accountIds: string[],
  eventId: string,
): Promise<Map<string, LockedAccount>> {
  const unique = [...new Set(accountIds)];
  if (unique.length === 0) return new Map();

  const rows = await tx.execute<LockedAccount>(sql`
    select id, type, balance, allow_negative as "allowNegative", status
      from accounts
     where id = any(${sql.raw(`ARRAY[${unique.map((id) => `'${assertUuid(id)}'`).join(',')}]::uuid[]`)})
       and event_id = ${eventId}
     order by id
       for update
  `);

  return new Map(rows.rows.map((row) => [row.id, { ...row, balance: Number(row.balance) }]));
}

/** Guards the one place an id is interpolated into SQL text (for ORDER BY + FOR UPDATE). */
function assertUuid(value: string): string {
  if (!/^[0-9a-fA-F-]{36}$/.test(value)) {
    throw new Error('Invalid account id.');
  }
  return value;
}

function mergeLegs(legs: LedgerLeg[]): LedgerLeg[] {
  const totals = new Map<string, number>();
  for (const leg of legs) {
    totals.set(leg.accountId, (totals.get(leg.accountId) ?? 0) + leg.amount);
  }
  return [...totals.entries()]
    .filter(([, amount]) => amount !== 0)
    .map(([accountId, amount]) => ({ accountId, amount }));
}

/* -------------------------------------------------------------------------- */
/* Account lookup and provisioning                                            */
/* -------------------------------------------------------------------------- */

/**
 * Points cannot be issued once an event has ended or been archived.
 *
 * Lives here rather than beside one caller because it holds for *every* way
 * points come into existence — a top-up, an allocation, a challenge reward. A
 * second copy of this rule is a second place for it to drift.
 */
export async function assertEventAcceptsPoints(db: Executor, eventId: string): Promise<void> {
  const [event] = await db
    .select({ status: events.status })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  if (!event) throw new NotFoundError('That event');
  if (event.status === 'ENDED' || event.status === 'ARCHIVED') {
    throw new EventNotOperationalError(event.status, 'issuing points');
  }
}

export async function getSystemAccount(
  db: Executor,
  eventId: string,
  type: Extract<AccountType, 'SYSTEM_ISSUANCE' | 'SYSTEM_FORFEITURE'>,
): Promise<string> {
  const [row] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.eventId, eventId), eq(accounts.type, type)))
    .limit(1);
  if (!row) {
    throw new Error(`Event ${eventId} has no ${type} account. Was it created correctly?`);
  }
  return row.id;
}

export async function getUserAccount(
  db: Executor,
  eventId: string,
  userId: string,
  type: Extract<AccountType, 'USER_SPENDABLE' | 'USER_SCORE'> = 'USER_SPENDABLE',
): Promise<string> {
  const [row] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(
        eq(accounts.eventId, eventId),
        eq(accounts.ownerUserId, userId),
        eq(accounts.type, type),
      ),
    )
    .limit(1);
  if (!row) throw new NotFoundError('A wallet for this participant');
  return row.id;
}

export async function getTeamAccount(
  db: Executor,
  eventId: string,
  teamId: string,
  type: Extract<AccountType, 'TEAM_SPENDABLE' | 'TEAM_SCORE'>,
): Promise<string> {
  const [row] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(
        eq(accounts.eventId, eventId),
        eq(accounts.ownerTeamId, teamId),
        eq(accounts.type, type),
      ),
    )
    .limit(1);
  if (!row) throw new NotFoundError("This team's wallet");
  return row.id;
}

/** Creates the pair of accounts a new participant needs. Idempotent. */
export async function provisionUserAccounts(
  db: Executor,
  eventId: string,
  userId: string,
  displayName: string,
): Promise<{ spendableAccountId: string; scoreAccountId: string }> {
  const created = await db
    .insert(accounts)
    .values([
      {
        eventId,
        type: 'USER_SPENDABLE' as const,
        ownerUserId: userId,
        name: `${displayName} — wallet`,
      },
      {
        eventId,
        type: 'USER_SCORE' as const,
        ownerUserId: userId,
        name: `${displayName} — score`,
      },
    ])
    .onConflictDoNothing()
    .returning({ id: accounts.id, type: accounts.type });

  if (created.length === 2) {
    const spendable = created.find((row) => row.type === 'USER_SPENDABLE');
    const score = created.find((row) => row.type === 'USER_SCORE');
    if (spendable && score) {
      return { spendableAccountId: spendable.id, scoreAccountId: score.id };
    }
  }

  return {
    spendableAccountId: await getUserAccount(db, eventId, userId, 'USER_SPENDABLE'),
    scoreAccountId: await getUserAccount(db, eventId, userId, 'USER_SCORE'),
  };
}

export async function provisionTeamAccounts(
  db: Executor,
  eventId: string,
  teamId: string,
  teamName: string,
): Promise<{ spendableAccountId: string; scoreAccountId: string }> {
  await db
    .insert(accounts)
    .values([
      {
        eventId,
        type: 'TEAM_SPENDABLE' as const,
        ownerTeamId: teamId,
        name: `${teamName} — team wallet`,
      },
      {
        eventId,
        type: 'TEAM_SCORE' as const,
        ownerTeamId: teamId,
        name: `${teamName} — team score`,
      },
    ])
    .onConflictDoNothing();

  return {
    spendableAccountId: await getTeamAccount(db, eventId, teamId, 'TEAM_SPENDABLE'),
    scoreAccountId: await getTeamAccount(db, eventId, teamId, 'TEAM_SCORE'),
  };
}

export interface AccountSnapshot {
  id: string;
  type: AccountType;
  balance: number;
  lifetimeCredited: number;
  lifetimeDebited: number;
  status: 'ACTIVE' | 'FROZEN' | 'CLOSED';
}

export async function getAccountSnapshot(
  db: Executor,
  accountId: string,
): Promise<AccountSnapshot> {
  const [row] = await db
    .select({
      id: accounts.id,
      type: accounts.type,
      balance: accounts.balance,
      lifetimeCredited: accounts.lifetimeCredited,
      lifetimeDebited: accounts.lifetimeDebited,
      status: accounts.status,
    })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  if (!row) throw new NotFoundError('That wallet');
  return row;
}

export async function getAccountSnapshots(
  db: Executor,
  accountIds: string[],
): Promise<Map<string, AccountSnapshot>> {
  if (accountIds.length === 0) return new Map();
  const rows = await db
    .select({
      id: accounts.id,
      type: accounts.type,
      balance: accounts.balance,
      lifetimeCredited: accounts.lifetimeCredited,
      lifetimeDebited: accounts.lifetimeDebited,
      status: accounts.status,
    })
    .from(accounts)
    .where(inArray(accounts.id, accountIds));
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * Conservation check: every event's accounts must sum to exactly zero, and
 * every materialised balance must equal its ledger sum. Both are proofs, not
 * estimates. Exposed for ops dashboards and asserted in the test suite.
 */
export async function verifyLedgerIntegrity(
  db: Executor,
  eventId: string,
): Promise<{ balanced: boolean; eventSum: number; driftingAccounts: number }> {
  const sumResult = await db.execute<{ total: string }>(
    sql`select coalesce(sum(balance), 0)::text as total from accounts where event_id = ${eventId}`,
  );
  const driftResult = await db.execute<{ count: string }>(
    sql`select count(*)::text as count from account_reconciliation
        where event_id = ${eventId} and drift <> 0`,
  );

  const eventSum = Number(sumResult.rows[0]?.total ?? 0);
  const driftingAccounts = Number(driftResult.rows[0]?.count ?? 0);

  return { balanced: eventSum === 0 && driftingAccounts === 0, eventSum, driftingAccounts };
}
