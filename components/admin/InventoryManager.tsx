'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, api } from '@/lib/client/api';
import { Alert, Badge, Button, Card, EmptyState } from '@/components/ui/primitives';

interface StockRow {
  productId: string;
  productName: string;
  sku: string;
  storeId: string;
  storeName: string;
  quantityOnHand: number;
  lowStockThreshold: number;
  trackInventory: boolean;
  isLow: boolean;
}

export function InventoryManager({
  stock,
  canAdjust,
}: {
  stock: StockRow[];
  canAdjust: boolean;
}): React.ReactElement {
  const router = useRouter();
  const [lowOnly, setLowOnly] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const visible = useMemo(
    () => (lowOnly ? stock.filter((row) => row.isLow && row.trackInventory) : stock),
    [stock, lowOnly],
  );
  const lowCount = stock.filter((row) => row.isLow && row.trackInventory).length;

  const adjust = (row: StockRow, type: 'RESTOCK' | 'DAMAGE' | 'LOSS' | 'ADJUSTMENT'): void => {
    const raw = window.prompt(
      type === 'RESTOCK'
        ? `How many units of ${row.productName} are arriving?`
        : `How many units of ${row.productName} are being removed?`,
    );
    const magnitude = Number(raw);
    if (!Number.isInteger(magnitude) || magnitude <= 0) return;

    const reason = window.prompt('Reason for this movement?');
    if (!reason || reason.trim().length < 3) return;

    const delta = type === 'RESTOCK' ? magnitude : -magnitude;

    setBusyId(row.productId);
    setMessage(null);
    void api('/api/inventory/adjust', {
      method: 'POST',
      body: { productId: row.productId, quantityDelta: delta, type, reason: reason.trim() },
    })
      .then(() => {
        setMessage({
          tone: 'success',
          text: `${row.productName} adjusted by ${delta > 0 ? '+' : ''}${delta}.`,
        });
        router.refresh();
      })
      .catch((error: unknown) => {
        setMessage({
          tone: 'danger',
          text: error instanceof ApiError ? error.message : 'That adjustment failed.',
        });
      })
      .finally(() => setBusyId(null));
  };

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink-900">Inventory</h1>
          <p className="text-sm text-ink-500">
            Every movement is recorded and cannot be edited afterwards.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm font-medium text-ink-700">
          <input
            type="checkbox"
            checked={lowOnly}
            onChange={(event) => setLowOnly(event.target.checked)}
            className="h-4 w-4 rounded border-ink-300"
          />
          Low stock only ({lowCount})
        </label>
      </header>

      {message ? <Alert tone={message.tone} title={message.text} /> : null}

      {visible.length === 0 ? (
        <EmptyState title="Nothing to show" description="No products match this filter." />
      ) : (
        <Card padded={false}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
                <tr>
                  <th className="px-4 py-2">Product</th>
                  <th className="hidden px-4 py-2 sm:table-cell">Store</th>
                  <th className="px-4 py-2 text-right">On hand</th>
                  <th className="hidden px-4 py-2 sm:table-cell">Status</th>
                  {canAdjust ? <th className="px-4 py-2 text-right">Adjust</th> : null}
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-200">
                {visible.map((row) => (
                  <tr key={row.productId} className={busyId === row.productId ? 'opacity-50' : ''}>
                    <td className="px-4 py-3">
                      <p className="font-medium text-ink-900">{row.productName}</p>
                      <p className="tabular text-xs text-ink-400">{row.sku}</p>
                    </td>
                    <td className="hidden px-4 py-3 text-ink-600 sm:table-cell">{row.storeName}</td>
                    <td className="tabular px-4 py-3 text-right font-semibold">
                      {row.trackInventory ? row.quantityOnHand.toLocaleString() : '∞'}
                    </td>
                    <td className="hidden px-4 py-3 sm:table-cell">
                      {!row.trackInventory ? (
                        <Badge>Not tracked</Badge>
                      ) : row.quantityOnHand === 0 ? (
                        <Badge tone="danger">Out of stock</Badge>
                      ) : row.isLow ? (
                        <Badge tone="warn">Low</Badge>
                      ) : (
                        <Badge tone="success">OK</Badge>
                      )}
                    </td>
                    {canAdjust ? (
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-1">
                          <Button size="sm" tone="neutral" onClick={() => adjust(row, 'RESTOCK')}>
                            Restock
                          </Button>
                          <Button size="sm" tone="warn" onClick={() => adjust(row, 'DAMAGE')}>
                            Write off
                          </Button>
                        </div>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
