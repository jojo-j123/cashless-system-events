import { requireSession } from '@/lib/auth/server';
import { getEventOverview, getSalesByStore, getTopProducts } from '@/lib/services/reports';
import { verifyLedgerIntegrity } from '@/lib/services/ledger';
import { Alert, Card, Points, StatTile } from '@/components/ui/primitives';

export const metadata = { title: 'Dashboard · Admin' };
export const dynamic = 'force-dynamic';

export default async function AdminDashboard(): Promise<React.ReactElement> {
  const session = await requireSession('report.read');

  const [overview, sales, products, integrity] = await Promise.all([
    getEventOverview(session.db, session.eventId),
    getSalesByStore(session.db, session.eventId),
    getTopProducts(session.db, session.eventId, { limit: 8 }),
    verifyLedgerIntegrity(session.db, session.eventId),
  ]);

  const maxSales = Math.max(1, ...sales.map((store) => store.netPoints));

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-ink-900">Dashboard</h1>
        <p className="text-sm text-ink-500">{session.eventName}</p>
      </header>

      {/*
        Ledger health is shown first and unconditionally. If conservation ever
        breaks, that is the most important fact on this screen.
      */}
      {integrity.balanced ? (
        <Alert tone="success" title="Ledger balanced">
          Every account reconciles to its entries and the event sums to zero.
        </Alert>
      ) : (
        <Alert tone="danger" title="Ledger integrity check failed">
          {integrity.driftingAccounts} account(s) drifted; event sum is {integrity.eventSum}.
          Investigate before issuing more points.
        </Alert>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Participants" value={overview.participants} />
        <StatTile
          label="Active cards"
          value={overview.activeCards}
          hint={`${overview.unassignedCards} unassigned · ${overview.suspendedCards} suspended`}
        />
        <StatTile label="Points issued" value={overview.pointsIssued} tone="brand" />
        <StatTile
          label="In circulation"
          value={overview.pointsInCirculation}
          hint="Unspent participant and team balances"
        />
        <StatTile label="Points spent" value={overview.pointsSpent} tone="success" />
        <StatTile label="Refunded" value={overview.pointsRefunded} tone="warn" />
        <StatTile
          label="Purchases today"
          value={overview.purchasesToday}
          hint={`${overview.spentToday.toLocaleString()} points`}
        />
        <StatTile
          label="Low stock"
          value={overview.lowStockProducts}
          tone={overview.lowStockProducts > 0 ? 'warn' : 'neutral'}
          hint={`${overview.activeStores} stores open`}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <h2 className="text-sm font-bold uppercase tracking-wide text-ink-500">
            Sales by store
          </h2>
          {sales.length === 0 ? (
            <p className="mt-4 text-sm text-ink-500">No sales yet.</p>
          ) : (
            <ul className="mt-3 space-y-3">
              {sales.map((store) => (
                <li key={store.storeId}>
                  <div className="flex items-baseline justify-between text-sm">
                    <span className="font-medium text-ink-800">{store.storeName}</span>
                    <span className="tabular text-ink-600">
                      {store.netPoints.toLocaleString()} · {store.purchases} sales
                    </span>
                  </div>
                  <div
                    className="mt-1 h-2 overflow-hidden rounded-full bg-ink-100"
                    role="img"
                    aria-label={`${store.storeName}: ${store.netPoints} points`}
                  >
                    <div
                      className="h-full rounded-full bg-brand-500"
                      style={{ width: `${Math.round((store.netPoints / maxSales) * 100)}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <h2 className="text-sm font-bold uppercase tracking-wide text-ink-500">
            Most popular products
          </h2>
          {products.length === 0 ? (
            <p className="mt-4 text-sm text-ink-500">No sales yet.</p>
          ) : (
            <ul className="mt-3 divide-y divide-ink-200">
              {products.map((product) => (
                <li key={product.productId} className="flex justify-between py-2 text-sm">
                  <div>
                    <p className="font-medium text-ink-800">{product.name}</p>
                    <p className="text-xs text-ink-500">{product.storeName}</p>
                  </div>
                  <div className="text-right">
                    <p className="tabular font-semibold">{product.unitsSold} sold</p>
                    <Points value={product.grossPoints} size="sm" />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card>
        <h2 className="text-sm font-bold uppercase tracking-wide text-ink-500">Export</h2>
        <div className="mt-3 flex flex-wrap gap-2">
          {['transactions', 'purchases', 'participants', 'inventory', 'teams', 'sales'].map(
            (dataset) => (
              <a
                key={dataset}
                href={`/api/export?dataset=${dataset}`}
                className="rounded-lg border border-ink-300 bg-white px-3 py-1.5 text-sm font-medium capitalize text-ink-700 hover:bg-ink-50"
              >
                {dataset}.csv
              </a>
            ),
          )}
        </div>
      </Card>
    </div>
  );
}
