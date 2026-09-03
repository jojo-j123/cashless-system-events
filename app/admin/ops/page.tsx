import { requireSession } from '@/lib/auth/server';
import { getOpsSnapshot, getSalesByStore } from '@/lib/services/reports';
import { listStock } from '@/lib/services/inventory';
import { Alert, Badge, Card, StatTile } from '@/components/ui/primitives';
import { eq, desc, sql } from 'drizzle-orm';
import { stores, terminals, users } from '@/lib/db/schema';

export const metadata = { title: 'Live operations · Admin' };
export const dynamic = 'force-dynamic';

/**
 * The screen the event operations team watches all night.
 *
 * Built to answer one question fast: is anything broken right now, and where?
 */
export default async function OpsPage(): Promise<React.ReactElement> {
  const session = await requireSession('ops.dashboard');

  const [snapshot, sales, lowStock, terminalRows] = await Promise.all([
    getOpsSnapshot(session.db, session.eventId),
    getSalesByStore(session.db, session.eventId),
    listStock(session.db, session.eventId, { lowOnly: true }),
    session.db
      .select({
        id: terminals.id,
        terminalRef: terminals.terminalRef,
        name: terminals.name,
        storeName: stores.name,
        cashierName: users.displayName,
        lastHeartbeatAt: terminals.lastHeartbeatAt,
        lastTransactionAt: terminals.lastTransactionAt,
        status: sql<string>`case
          when ${terminals.isDisabled} then 'DISABLED'
          when ${terminals.lastHeartbeatAt} is null then 'OFFLINE'
          when ${terminals.lastHeartbeatAt} > now() - interval '2 minutes' then 'ONLINE'
          when ${terminals.lastHeartbeatAt} > now() - interval '15 minutes' then 'ERROR'
          else 'OFFLINE' end`,
      })
      .from(terminals)
      .leftJoin(stores, eq(stores.id, terminals.storeId))
      .leftJoin(users, eq(users.id, terminals.assignedCashierUserId))
      .where(eq(terminals.eventId, session.eventId))
      .orderBy(desc(terminals.lastHeartbeatAt)),
  ]);

  const problems = terminalRows.filter(
    (terminal) => terminal.status === 'ERROR' || terminal.status === 'OFFLINE',
  );

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-ink-900">Live operations</h1>
        <p className="text-sm text-ink-500">
          {session.eventName} · refreshed {new Date().toLocaleTimeString()}
        </p>
      </header>

      {!snapshot.ledgerBalanced ? (
        <Alert tone="danger" title="Ledger integrity check failed">
          {snapshot.ledgerDrift} account(s) do not reconcile. Stop issuing points and investigate.
        </Alert>
      ) : null}

      {problems.length > 0 ? (
        <Alert tone="warn" title={`${problems.length} terminal(s) need attention`}>
          {problems.map((terminal) => `${terminal.name} (${terminal.storeName ?? 'no store'})`).join(', ')}
        </Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Stores open"
          value={`${snapshot.storesOnline} / ${snapshot.storesTotal}`}
          tone={snapshot.storesOnline < snapshot.storesTotal ? 'warn' : 'success'}
        />
        <StatTile
          label="Terminals online"
          value={`${snapshot.terminalsOnline} / ${snapshot.terminalsTotal}`}
          tone={snapshot.terminalsOnline < snapshot.terminalsTotal ? 'warn' : 'success'}
        />
        <StatTile
          label="Transactions / min"
          value={snapshot.transactionsLastMinute}
          hint={`${snapshot.transactionsLastHour} in the last hour`}
        />
        <StatTile
          label="Failed (1h)"
          value={snapshot.failedTransactionsLastHour}
          tone={snapshot.failedTransactionsLastHour > 0 ? 'danger' : 'success'}
        />
        <StatTile
          label="Cards suspended"
          value={snapshot.cardsSuspended}
          tone={snapshot.cardsSuspended > 0 ? 'warn' : 'neutral'}
        />
        <StatTile
          label="Low stock lines"
          value={snapshot.lowStockCount}
          tone={snapshot.lowStockCount > 0 ? 'warn' : 'neutral'}
        />
        <StatTile
          label="Ledger"
          value={snapshot.ledgerBalanced ? 'Balanced' : 'DRIFT'}
          tone={snapshot.ledgerBalanced ? 'success' : 'danger'}
        />
        <StatTile label="Top store" value={sales[0]?.storeName ?? '—'} hint={
          sales[0] ? `${sales[0].netPoints.toLocaleString()} points` : undefined
        } />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <h2 className="text-sm font-bold uppercase tracking-wide text-ink-500">POS terminals</h2>
          {terminalRows.length === 0 ? (
            <p className="mt-4 text-sm text-ink-500">No terminals registered.</p>
          ) : (
            <table className="mt-3 w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-ink-400">
                  <th className="pb-2">Terminal</th>
                  <th className="pb-2">Store</th>
                  <th className="pb-2">Last seen</th>
                  <th className="pb-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-200">
                {terminalRows.map((terminal) => (
                  <tr key={terminal.id}>
                    <td className="py-2">
                      <p className="font-medium text-ink-800">{terminal.name}</p>
                      <p className="tabular text-xs text-ink-400">{terminal.terminalRef}</p>
                    </td>
                    <td className="py-2 text-ink-600">{terminal.storeName ?? '—'}</td>
                    <td className="py-2 text-xs text-ink-500">
                      {terminal.lastHeartbeatAt
                        ? new Date(terminal.lastHeartbeatAt).toLocaleTimeString()
                        : 'never'}
                    </td>
                    <td className="py-2">
                      <Badge
                        tone={
                          terminal.status === 'ONLINE'
                            ? 'success'
                            : terminal.status === 'ERROR'
                              ? 'danger'
                              : 'warn'
                        }
                      >
                        {terminal.status}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card>
          <h2 className="text-sm font-bold uppercase tracking-wide text-ink-500">
            Low stock right now
          </h2>
          {lowStock.length === 0 ? (
            <p className="mt-4 text-sm text-ink-500">Everything is well stocked.</p>
          ) : (
            <ul className="mt-3 divide-y divide-ink-200">
              {lowStock.map((item) => (
                <li key={item.productId} className="flex justify-between py-2 text-sm">
                  <div>
                    <p className="font-medium text-ink-800">{item.productName}</p>
                    <p className="text-xs text-ink-500">{item.storeName}</p>
                  </div>
                  <Badge tone={item.quantityOnHand === 0 ? 'danger' : 'warn'}>
                    {item.quantityOnHand} left
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
