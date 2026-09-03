'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CardCredential } from '@/lib/nfc/credentials';
import type { ResolvedCard } from '@/lib/services/cards';
import type { Receipt } from '@/lib/services/purchases';
import { ApiError, api, newIdempotencyKey, submitWithRetry } from '@/lib/client/api';
import { useCardReader } from '@/components/nfc/useCardReader';
import { TapPanel } from '@/components/nfc/TapPanel';
import { Alert, Badge, Button, Card, EmptyState, Points, Spinner } from '@/components/ui/primitives';

interface Product {
  id: string;
  sku: string;
  name: string;
  pricePoints: number;
  quantityOnHand: number | null;
  trackInventory: boolean | null;
  sellable: boolean;
  isLow: boolean;
  categoryName: string | null;
}

interface StoreOption {
  id: string;
  name: string;
  isOpen: boolean;
  isActive: boolean;
}

type Stage = 'waiting' | 'shopping' | 'complete';
type Connection = 'ONLINE' | 'OFFLINE' | 'SYNCING' | 'ERROR';

interface SimulatorCard {
  id: string;
  cardRef: string;
  displayName: string | null;
}

/**
 * The cashier terminal.
 *
 * Optimised for one thing: tap, tap items, confirm, next customer. The
 * cashier cannot change a price or a balance anywhere on this screen — the
 * server prices the basket and the server owns the wallet.
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
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [stage, setStage] = useState<Stage>('waiting');
  const [customer, setCustomer] = useState<ResolvedCard | null>(null);
  const [cart, setCart] = useState<Map<string, number>>(new Map());
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [connection, setConnection] = useState<Connection>('ONLINE');
  const [retryNotice, setRetryNotice] = useState<string | null>(null);

  // Held across retries so a replay can never become a second charge.
  const idempotencyKeyRef = useRef<string | null>(null);

  /* -- Catalogue --------------------------------------------------------- */
  useEffect(() => {
    if (!storeId) return;
    let cancelled = false;
    setLoadingProducts(true);

    void api<{ data: Product[] }>(`/api/stores/${storeId}/products`)
      .then((response) => {
        if (!cancelled) setProducts(response.data);
      })
      .catch(() => {
        if (!cancelled) setError('Could not load the product list.');
      })
      .finally(() => {
        if (!cancelled) setLoadingProducts(false);
      });

    return () => {
      cancelled = true;
    };
  }, [storeId]);

  /* -- Terminal heartbeat and connection state ---------------------------- */
  useEffect(() => {
    if (!terminalId) return undefined;

    const beat = async (): Promise<void> => {
      try {
        await api(`/api/terminals/${terminalId}/heartbeat`, {
          method: 'POST',
          body: { appVersion: '1.0.0' },
        });
        setConnection('ONLINE');
      } catch {
        setConnection('OFFLINE');
      }
    };

    void beat();
    const timer = setInterval(() => void beat(), 45_000);
    return () => clearInterval(timer);
  }, [terminalId]);

  useEffect(() => {
    const online = (): void => setConnection('ONLINE');
    const offline = (): void => setConnection('OFFLINE');
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
    };
  }, []);

  /* -- Tap handling ------------------------------------------------------- */
  const handleCredential = useCallback(
    async (credential: CardCredential) => {
      if (busy) return;
      setBusy(true);
      setError(null);

      try {
        const resolved = await api<ResolvedCard>('/api/cards/resolve', {
          method: 'POST',
          body: {
            kind: credential.kind,
            value: credential.value,
            storeId,
            ...(terminalId ? { terminalId } : {}),
          },
        });
        setCustomer(resolved);
        setCart(new Map());
        setReceipt(null);
        idempotencyKeyRef.current = newIdempotencyKey();
        setStage('shopping');
        beep(880);
      } catch (resolveError) {
        setError(
          resolveError instanceof ApiError
            ? resolveError.message
            : 'That card could not be read. Please try again.',
        );
        beep(220);
      } finally {
        setBusy(false);
      }
    },
    [busy, storeId, terminalId],
  );

  const reader = useCardReader(
    (credential) => void handleCredential(credential),
    { enabled: stage === 'waiting' || stage === 'complete' },
  );

  /* -- Basket ------------------------------------------------------------- */
  const lines = useMemo(
    () =>
      [...cart.entries()].map(([productId, quantity]) => {
        const product = products.find((entry) => entry.id === productId);
        return {
          productId,
          quantity,
          name: product?.name ?? 'Item',
          unitPricePoints: product?.pricePoints ?? 0,
          lineTotal: (product?.pricePoints ?? 0) * quantity,
        };
      }),
    [cart, products],
  );

  // Shown for the cashier's benefit only. The server recomputes the real
  // total from its own prices and that figure is the one that is charged.
  const previewTotal = lines.reduce((sum, line) => sum + line.lineTotal, 0);
  const affordable = customer ? previewTotal <= customer.balance : false;

  const addToCart = (product: Product): void => {
    if (!product.sellable) return;
    setCart((current) => {
      const next = new Map(current);
      const quantity = (next.get(product.id) ?? 0) + 1;
      if (product.trackInventory && product.quantityOnHand !== null && quantity > product.quantityOnHand) {
        return current;
      }
      next.set(product.id, quantity);
      return next;
    });
  };

  const setQuantity = (productId: string, quantity: number): void => {
    setCart((current) => {
      const next = new Map(current);
      if (quantity <= 0) next.delete(productId);
      else next.set(productId, quantity);
      return next;
    });
  };

  const resetTerminal = (): void => {
    setStage('waiting');
    setCustomer(null);
    setCart(new Map());
    setReceipt(null);
    setError(null);
    setRetryNotice(null);
    idempotencyKeyRef.current = null;
  };

  /* -- Checkout ----------------------------------------------------------- */
  const confirmPurchase = async (): Promise<void> => {
    if (!customer || cart.size === 0 || busy) return;

    const key = idempotencyKeyRef.current ?? newIdempotencyKey();
    idempotencyKeyRef.current = key;

    setBusy(true);
    setError(null);
    setRetryNotice(null);

    try {
      const result = await submitWithRetry<Receipt>(
        '/api/purchases',
        {
          storeId,
          userId: customer.userId,
          cardId: customer.cardId,
          ...(terminalId ? { terminalId } : {}),
          lines: [...cart.entries()].map(([productId, quantity]) => ({ productId, quantity })),
        },
        key,
        {
          onAttempt: (attempt) => {
            if (attempt > 1) {
              setConnection('SYNCING');
              setRetryNotice(`Network is slow — retrying (attempt ${attempt}). No double charge.`);
            }
          },
        },
      );

      setReceipt(result);
      setStage('complete');
      setConnection('ONLINE');
      setRetryNotice(null);
      beep(1_320);

      // Stock moved; refresh so the next customer sees the truth.
      void api<{ data: Product[] }>(`/api/stores/${storeId}/products`)
        .then((response) => setProducts(response.data))
        .catch(() => undefined);
    } catch (checkoutError) {
      setConnection('ERROR');
      setError(
        checkoutError instanceof ApiError
          ? checkoutError.message
          : 'The purchase could not be completed. No points were deducted.',
      );
      beep(220);
    } finally {
      setBusy(false);
    }
  };

  /* -- Render ------------------------------------------------------------- */
  return (
    <div className="min-h-screen bg-ink-100">
      <header className="sticky top-0 z-10 border-b border-ink-200 bg-white px-4 py-3">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="text-lg font-bold text-ink-900">Point of sale</span>
            <select
              value={storeId}
              onChange={(event) => {
                setStoreId(event.target.value);
                resetTerminal();
              }}
              aria-label="Store"
              className="rounded-lg border border-ink-300 px-3 py-1.5 text-sm font-medium"
            >
              {stores.map((store) => (
                <option key={store.id} value={store.id}>
                  {store.name}
                  {store.isOpen ? '' : ' (closed)'}
                </option>
              ))}
            </select>
          </div>
          <ConnectionBadge state={connection} />
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">
        {error ? (
          <div className="mb-4">
            <Alert tone="danger" title={error}>
              Nothing was charged. You can try again.
            </Alert>
          </div>
        ) : null}
        {retryNotice ? (
          <div className="mb-4">
            <Alert tone="warn" title={retryNotice} />
          </div>
        ) : null}

        {stage === 'complete' && receipt ? (
          <ReceiptView receipt={receipt} onNext={resetTerminal} />
        ) : stage === 'waiting' ? (
          <div className="grid gap-4">
            <TapPanel
              reader={reader}
              busy={busy}
              onManualEntry={(credential) => void handleCredential(credential)}
            />
            {reader.simulate && simulatorCards.length > 0 ? (
              <SimulatorPanel
                cards={simulatorCards}
                onSimulate={(cardRef) =>
                  reader.simulate?.({ kind: 'MANUAL_REF', value: cardRef })
                }
              />
            ) : null}
          </div>
        ) : (
          <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
            <div>
              <CustomerBar customer={customer} onCancel={resetTerminal} />
              {loadingProducts ? (
                <Card className="mt-4">
                  <Spinner label="Loading products…" />
                </Card>
              ) : products.length === 0 ? (
                <div className="mt-4">
                  <EmptyState
                    title="No products"
                    description="This store has no products set up yet."
                  />
                </div>
              ) : (
                <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {products.map((product) => (
                    <ProductTile
                      key={product.id}
                      product={product}
                      quantity={cart.get(product.id) ?? 0}
                      onAdd={() => addToCart(product)}
                    />
                  ))}
                </div>
              )}
            </div>

            <BasketPanel
              lines={lines}
              total={previewTotal}
              balance={customer?.balance ?? 0}
              affordable={affordable}
              busy={busy}
              onSetQuantity={setQuantity}
              onConfirm={() => void confirmPurchase()}
              onCancel={resetTerminal}
            />
          </div>
        )}
      </main>
    </div>
  );
}

function ConnectionBadge({ state }: { state: Connection }): React.ReactElement {
  const config = {
    ONLINE: { tone: 'success' as const, label: 'Online' },
    SYNCING: { tone: 'warn' as const, label: 'Syncing' },
    OFFLINE: { tone: 'danger' as const, label: 'Offline — purchases paused' },
    ERROR: { tone: 'danger' as const, label: 'Error' },
  }[state];

  return <Badge tone={config.tone}>{config.label}</Badge>;
}

function CustomerBar({
  customer,
  onCancel,
}: {
  customer: ResolvedCard | null;
  onCancel: () => void;
}): React.ReactElement | null {
  if (!customer) return null;

  return (
    <Card className="flex flex-wrap items-center justify-between gap-4">
      <div className="flex items-center gap-4">
        <div
          className="flex h-14 w-14 items-center justify-center rounded-full text-lg font-bold text-white"
          style={{ backgroundColor: customer.teamColor ?? '#475569' }}
          aria-hidden
        >
          {customer.displayName.slice(0, 1).toUpperCase()}
        </div>
        <div>
          <p className="text-xl font-bold text-ink-900">{customer.displayName}</p>
          <p className="text-sm text-ink-500">
            {customer.teamName ?? 'No team'} · {customer.cardRef}
          </p>
        </div>
      </div>

      <div className="text-right">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-500">Balance</p>
        <Points value={customer.balance} size="lg" />
        {customer.lowBalance ? (
          <p className="mt-1">
            <Badge tone="warn">Low balance</Badge>
          </p>
        ) : null}
      </div>

      <Button tone="neutral" onClick={onCancel}>
        Cancel
      </Button>
    </Card>
  );
}

function ProductTile({
  product,
  quantity,
  onAdd,
}: {
  product: Product;
  quantity: number;
  onAdd: () => void;
}): React.ReactElement {
  const outOfStock = !product.sellable;

  return (
    <button
      type="button"
      onClick={onAdd}
      disabled={outOfStock}
      className={`touch-target relative flex flex-col items-start justify-between rounded-2xl border p-4 text-left transition
        ${
          outOfStock
            ? 'cursor-not-allowed border-ink-200 bg-ink-50 opacity-60'
            : 'border-ink-200 bg-white hover:border-brand-400 hover:shadow-md active:scale-[0.98]'
        }`}
    >
      {quantity > 0 ? (
        <span className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-brand-600 text-sm font-bold text-white">
          {quantity}
        </span>
      ) : null}
      <span className="pr-8 text-sm font-semibold leading-tight text-ink-900">{product.name}</span>
      <span className="mt-2 flex w-full items-end justify-between">
        <Points value={product.pricePoints} />
        {outOfStock ? (
          <Badge tone="danger">Out of stock</Badge>
        ) : product.isLow ? (
          <Badge tone="warn">{product.quantityOnHand} left</Badge>
        ) : null}
      </span>
    </button>
  );
}

function BasketPanel({
  lines,
  total,
  balance,
  affordable,
  busy,
  onSetQuantity,
  onConfirm,
  onCancel,
}: {
  lines: { productId: string; name: string; quantity: number; unitPricePoints: number; lineTotal: number }[];
  total: number;
  balance: number;
  affordable: boolean;
  busy: boolean;
  onSetQuantity: (productId: string, quantity: number) => void;
  onConfirm: () => void;
  onCancel: () => void;
}): React.ReactElement {
  return (
    <Card className="flex h-fit flex-col gap-4 lg:sticky lg:top-24">
      <h2 className="text-lg font-bold text-ink-900">Basket</h2>

      {lines.length === 0 ? (
        <p className="py-8 text-center text-sm text-ink-500">Tap products to add them.</p>
      ) : (
        <ul className="divide-y divide-ink-200">
          {lines.map((line) => (
            <li key={line.productId} className="flex items-center justify-between gap-2 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-ink-900">{line.name}</p>
                <p className="tabular text-xs text-ink-500">
                  {line.quantity} × {line.unitPricePoints.toLocaleString()}
                </p>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  tone="neutral"
                  onClick={() => onSetQuantity(line.productId, line.quantity - 1)}
                >
                  −
                </Button>
                <span className="tabular w-8 text-center text-sm font-semibold">
                  {line.quantity}
                </span>
                <Button
                  size="sm"
                  tone="neutral"
                  onClick={() => onSetQuantity(line.productId, line.quantity + 1)}
                >
                  +
                </Button>
              </div>
              <Points value={line.lineTotal} />
            </li>
          ))}
        </ul>
      )}

      <dl className="space-y-1 border-t border-ink-200 pt-3 text-sm">
        <div className="flex justify-between">
          <dt className="text-ink-500">Total</dt>
          <dd>
            <Points value={total} size="lg" />
          </dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-ink-500">Balance after</dt>
          <dd className={affordable ? 'tabular font-semibold' : 'tabular font-semibold text-danger-700'}>
            {(balance - total).toLocaleString()}
          </dd>
        </div>
      </dl>

      {!affordable && lines.length > 0 ? (
        <Alert tone="danger" title="Insufficient points">
          Short by {(total - balance).toLocaleString()} points.
        </Alert>
      ) : null}

      <div className="flex flex-col gap-2">
        <Button
          size="lg"
          tone="success"
          fullWidth
          disabled={busy || lines.length === 0 || !affordable}
          onClick={onConfirm}
        >
          {busy ? 'Processing…' : `Charge ${total.toLocaleString()} points`}
        </Button>
        <Button tone="neutral" fullWidth onClick={onCancel} disabled={busy}>
          Cancel sale
        </Button>
      </div>
    </Card>
  );
}

function ReceiptView({
  receipt,
  onNext,
}: {
  receipt: Receipt;
  onNext: () => void;
}): React.ReactElement {
  return (
    <div className="mx-auto max-w-lg">
      <Card className="text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-success-50">
          <svg viewBox="0 0 24 24" className="h-8 w-8 text-success-600" fill="none" strokeWidth={2.5}>
            <path d="m5 13 4 4L19 7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <h2 className="mt-4 text-2xl font-bold text-ink-900">Payment successful</h2>
        <p className="mt-1 text-sm text-ink-500">{receipt.storeName}</p>

        <div className="mt-6 rounded-xl bg-ink-50 p-4 text-left">
          <ul className="divide-y divide-ink-200">
            {receipt.lines.map((line) => (
              <li key={line.productId} className="flex justify-between py-2 text-sm">
                <span>
                  {line.name} × {line.quantity}
                </span>
                <Points value={line.lineTotalPoints} />
              </li>
            ))}
          </ul>
          <dl className="mt-3 space-y-1 border-t border-ink-300 pt-3 text-sm">
            <div className="flex justify-between font-semibold">
              <dt>Total</dt>
              <dd>
                <Points value={receipt.totalPoints} />
              </dd>
            </div>
            <div className="flex justify-between text-ink-500">
              <dt>Previous balance</dt>
              <dd className="tabular">{receipt.balanceBefore.toLocaleString()}</dd>
            </div>
            <div className="flex justify-between font-semibold">
              <dt>New balance</dt>
              <dd>
                <Points value={receipt.balanceAfter} size="lg" />
              </dd>
            </div>
          </dl>
        </div>

        {receipt.lowBalance ? (
          <div className="mt-4">
            <Alert tone="warn" title="Low balance">
              Let the participant know they may want a top-up.
            </Alert>
          </div>
        ) : null}

        <p className="tabular mt-4 text-xs text-ink-500">
          {receipt.purchaseRef} · {receipt.txnRef} ·{' '}
          {new Date(receipt.createdAt).toLocaleTimeString()}
        </p>

        <div className="mt-6 flex gap-2">
          <Button size="lg" fullWidth onClick={onNext}>
            Next customer
          </Button>
          <Button tone="neutral" size="lg" onClick={() => window.print()}>
            Print
          </Button>
        </div>
      </Card>
    </div>
  );
}

function SimulatorPanel({
  cards,
  onSimulate,
}: {
  cards: SimulatorCard[];
  onSimulate: (cardRef: string) => void;
}): React.ReactElement {
  return (
    <Card>
      <h3 className="text-sm font-bold uppercase tracking-wide text-ink-500">
        Development simulator
      </h3>
      <p className="mt-1 text-sm text-ink-600">
        Simulating a tap sends a real credential through the same endpoint as physical
        hardware. Card status, permissions and wallet rules all still apply.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {cards.map((card) => (
          <Button key={card.id} tone="neutral" size="sm" onClick={() => onSimulate(card.cardRef)}>
            {card.displayName ?? card.cardRef}
          </Button>
        ))}
      </div>
    </Card>
  );
}

/** Audible confirmation matters when a cashier is not looking at the screen. */
function beep(frequency: number): void {
  try {
    const AudioCtor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtor) return;

    const context = new AudioCtor();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = frequency;
    gain.gain.value = 0.06;
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.12);
    setTimeout(() => void context.close(), 300);
  } catch {
    // Sound is a nicety; never let it break a sale.
  }
  if ('vibrate' in navigator) navigator.vibrate?.(30);
}
