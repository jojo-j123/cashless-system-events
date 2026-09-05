'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CardCredential } from '@/lib/nfc/credentials';
import type { ResolvedCard } from '@/lib/services/cards';
import type { Receipt } from '@/lib/services/purchases';
import { ApiError, api, newIdempotencyKey, submitWithRetry } from '@/lib/client/api';
import { useCardReader } from '@/components/nfc/useCardReader';
import { TapPanel } from '@/components/nfc/TapPanel';
import { Alert, Button, Card, EmptyState, Points, Spinner } from '@/components/ui/primitives';

interface Product {
  id: string;
  sku: string;
  name: string;
  pricePoints: number;
  quantityOnHand: number | null;
  trackInventory: boolean | null;
  sellable: boolean;
  categoryName: string | null;
}

interface StoreOption {
  id: string;
  name: string;
  isOpen: boolean;
  isActive: boolean;
}

interface SimulatorCard {
  id: string;
  cardRef: string;
  displayName: string | null;
}

type Stage = 'ringing' | 'charging' | 'done';

/**
 * The cashier terminal.
 *
 * Ring up first, tap once at the end. The alternative — tap, then shop — holds
 * the customer at the counter for the whole basket and taps them again if the
 * session drops. One tap per customer is the difference between a queue that
 * moves and one that does not.
 *
 * The cashier cannot type a price, a balance, or a card number anywhere on
 * this screen. The server prices the basket and the server owns the wallet.
 */
export function PosTerminal({
  stores,
  simulatorCards,
  terminalId,
}: {
  stores: StoreOption[];
  simulatorCards: SimulatorCard[];
  terminalId: string | null;
}): React.ReactElement {
  const [storeId, setStoreId] = useState(stores[0]?.id ?? '');
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(false);
  const [basket, setBasket] = useState<Record<string, number>>({});
  const [stage, setStage] = useState<Stage>('ringing');
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [error, setError] = useState<string | null>(null);

  const store = stores.find((candidate) => candidate.id === storeId) ?? null;

  useEffect(() => {
    if (!storeId) return;
    setLoading(true);
    void api<{ data: Product[] }>(`/api/stores/${storeId}/products`)
      .then((response) => setProducts(response.data))
      .catch(() => setError('Could not load products. Check the connection and try again.'))
      .finally(() => setLoading(false));
  }, [storeId]);

  const lines = useMemo(
    () =>
      Object.entries(basket)
        .filter(([, quantity]) => quantity > 0)
        .map(([productId, quantity]) => ({ productId, quantity })),
    [basket],
  );

  const total = useMemo(
    () =>
      lines.reduce((sum, line) => {
        const product = products.find((candidate) => candidate.id === line.productId);
        return sum + (product ? product.pricePoints * line.quantity : 0);
      }, 0),
    [lines, products],
  );

  function adjust(productId: string, delta: number): void {
    setError(null);
    setBasket((current) => {
      const next = { ...current };
      const quantity = (next[productId] ?? 0) + delta;
      if (quantity <= 0) delete next[productId];
      else next[productId] = quantity;
      return next;
    });
  }

  function startNextCustomer(): void {
    setBasket({});
    setReceipt(null);
    setError(null);
    setStage('ringing');
  }

  /**
   * Resolve the tap, then charge it.
   *
   * A fresh idempotency key per tap: `submitWithRetry` replays that same key
   * over a flaky network so a timeout cannot charge twice, while a genuinely
   * new tap — a different card after a decline — gets its own key and is
   * correctly treated as a new sale.
   */
  const charge = useCallback(
    async (credential: CardCredential) => {
      if (lines.length === 0 || stage !== 'ringing') return;

      setStage('charging');
      setError(null);

      try {
        const holder = await api<ResolvedCard>('/api/cards/resolve', {
          method: 'POST',
          body: { ...credential, storeId, terminalId },
        });

        const paid = await submitWithRetry<Receipt>(
          '/api/purchases',
          { storeId, userId: holder.userId, cardId: holder.cardId, terminalId, lines },
          newIdempotencyKey(),
        );

        setReceipt(paid);
        setStage('done');
      } catch (failure) {
        setError(
          failure instanceof ApiError
            ? failure.message
            : 'The charge did not go through. Try the tap again.',
        );
        setStage('ringing');
      }
    },
    [lines, stage, storeId, terminalId],
  );

  // Readers hand back a plain callback, so the async charge is kicked off
  // rather than awaited here; every failure is already surfaced as state.
  const onTap = useCallback(
    (credential: CardCredential) => {
      void charge(credential);
    },
    [charge],
  );

  // Armed only while there is something to charge, so a stray tap against a
  // resting terminal can never move money.
  const reader = useCardReader(onTap, { enabled: stage === 'ringing' && lines.length > 0 });

  if (stage === 'done' && receipt) {
    return <PaidScreen receipt={receipt} onNext={startNextCustomer} />;
  }

  return (
    <div className="min-h-screen bg-ink-100 pb-64">
      <header className="sticky top-0 z-10 border-b border-ink-200 bg-white px-4 py-3">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
          {stores.length > 1 ? (
            <select
              value={storeId}
              onChange={(event) => {
                setStoreId(event.target.value);
                setBasket({});
              }}
              className="rounded-xl border border-ink-300 px-3 py-2 text-sm font-semibold"
            >
              {stores.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </select>
          ) : (
            <p className="text-sm font-bold text-ink-900">{store?.name ?? 'No store'}</p>
          )}
          {lines.length > 0 ? (
            <Button size="sm" tone="neutral" onClick={() => setBasket({})}>
              Clear
            </Button>
          ) : null}
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-4 p-4">
        {error ? <Alert tone="danger" title="That did not go through">{error}</Alert> : null}

        {store && !store.isOpen ? (
          <Alert tone="warn" title="Store closed">
            Sales are still recorded against it.
          </Alert>
        ) : null}

        {loading ? (
          <Spinner label="Loading products" />
        ) : products.length === 0 ? (
          <EmptyState
            title="No products"
            description="Nothing is set up to sell at this store yet."
          />
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {products.map((product) => {
              const inBasket = basket[product.id] ?? 0;
              const soldOut =
                product.trackInventory === true &&
                product.quantityOnHand !== null &&
                product.quantityOnHand <= inBasket;

              return (
                <button
                  key={product.id}
                  type="button"
                  disabled={!product.sellable || soldOut}
                  onClick={() => adjust(product.id, 1)}
                  className={`touch-target flex min-h-24 flex-col justify-between rounded-2xl border p-3 text-left transition
                    disabled:cursor-not-allowed disabled:opacity-40
                    ${inBasket > 0 ? 'border-brand-500 bg-brand-50' : 'border-ink-200 bg-white'}`}
                >
                  <span className="text-sm font-semibold leading-tight text-ink-900">
                    {product.name}
                  </span>
                  <span className="mt-2 flex items-baseline justify-between">
                    <Points value={product.pricePoints} />
                    {inBasket > 0 ? (
                      <span className="rounded-full bg-brand-600 px-2 py-0.5 text-xs font-bold text-white">
                        {inBasket}
                      </span>
                    ) : soldOut ? (
                      <span className="text-xs font-semibold text-danger-700">Sold out</span>
                    ) : null}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {lines.length > 0 ? (
          <Card>
            <ul className="divide-y divide-ink-100">
              {lines.map((line) => {
                const product = products.find((candidate) => candidate.id === line.productId);
                if (!product) return null;
                return (
                  <li key={line.productId} className="flex items-center gap-3 py-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink-800">
                      {product.name}
                    </span>
                    <Points value={product.pricePoints * line.quantity} />
                    <span className="flex items-center gap-1">
                      <Button size="sm" tone="neutral" onClick={() => adjust(line.productId, -1)}>
                        −
                      </Button>
                      <span className="tabular w-6 text-center text-sm font-bold">
                        {line.quantity}
                      </span>
                      <Button size="sm" tone="neutral" onClick={() => adjust(line.productId, 1)}>
                        +
                      </Button>
                    </span>
                  </li>
                );
              })}
            </ul>
          </Card>
        ) : null}
      </main>

      <footer className="fixed inset-x-0 bottom-0 border-t border-ink-200 bg-white p-4">
        <div className="mx-auto max-w-3xl">
          <div className="mb-3 flex items-baseline justify-between">
            <span className="text-sm font-semibold uppercase tracking-wide text-ink-500">Total</span>
            <Points value={total} size="lg" />
          </div>

          {stage === 'charging' ? (
            <div className="flex items-center justify-center rounded-2xl bg-brand-50 py-6">
              <Spinner label="Charging the card" />
            </div>
          ) : lines.length === 0 ? (
            <p className="rounded-2xl bg-ink-50 py-6 text-center text-sm text-ink-500">
              Add items, then tap the card.
            </p>
          ) : (
            <TapPanel reader={reader} onManualEntry={onTap} busy={false} />
          )}

          {simulatorCards.length > 0 && reader.simulate ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {simulatorCards.map((card) => (
                <Button
                  key={card.id}
                  size="sm"
                  tone="neutral"
                  onClick={() => reader.simulate?.({ kind: 'MANUAL_REF', value: card.cardRef })}
                >
                  {card.displayName ?? card.cardRef}
                </Button>
              ))}
            </div>
          ) : null}
        </div>
      </footer>
    </div>
  );
}

/**
 * What the cashier reads out loud.
 *
 * The remaining balance is the largest thing on the screen because it is the
 * one number the customer asks for every single time.
 */
function PaidScreen({
  receipt,
  onNext,
}: {
  receipt: Receipt;
  onNext: () => void;
}): React.ReactElement {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-success-50 p-6 text-center">
      <div>
        <p className="text-sm font-bold uppercase tracking-wide text-success-700">Paid</p>
        <p className="mt-1 text-2xl font-bold text-ink-900">{receipt.participantName}</p>
      </div>

      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-sm">
        <p className="text-sm text-ink-500">Charged</p>
        <Points value={receipt.totalPoints} size="lg" />

        <hr className="my-5 border-ink-100" />

        <p className="text-sm font-semibold uppercase tracking-wide text-ink-500">
          Remaining balance
        </p>
        <div className="mt-1">
          <Points value={receipt.balanceAfter} size="xl" />
        </div>

        {receipt.lowBalance ? (
          <p className="mt-4 rounded-xl bg-warn-50 px-3 py-2 text-sm font-semibold text-warn-800">
            Low balance — offer a top-up.
          </p>
        ) : null}
      </div>

      <Button size="lg" fullWidth className="max-w-sm" onClick={onNext}>
        Next customer
      </Button>
    </div>
  );
}
