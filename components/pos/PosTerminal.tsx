'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CardCredential } from '@/lib/nfc/credentials';
import type { ResolvedCard } from '@/lib/services/cards';
import type { Receipt } from '@/lib/services/purchases';
import { ApiError, api, newIdempotencyKey, submitWithRetry } from '@/lib/client/api';
import { useCardReader } from '@/components/nfc/useCardReader';
import { TapPanel } from '@/components/nfc/TapPanel';
import { Alert, Button, Card, EmptyState, Points, Spinner } from '@/components/ui/primitives';
import { SignOutButton } from '@/components/auth/SignOutButton';

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

type Stage = 'waiting' | 'ringing' | 'charging' | 'done';

/**
 * The cashier terminal, in whichever direction the event runs it.
 *
 * RING_FIRST builds the basket and taps once at the end. The alternative —
 * tap, then shop — holds the customer at the counter for the whole basket and
 * taps them again if the session drops. One tap per customer is the difference
 * between a queue that moves and one that does not.
 *
 * TAP_FIRST pays that cost deliberately to buy away the worst moment at a till:
 * a basket that is rung up, tapped, and declined. Reading the card first puts
 * the balance on screen while the customer is still choosing, so the sale
 * cannot end in a decline — a shortfall becomes a top-up before it becomes a
 * refusal. Worth it at a merch stand where top-ups are constant; not worth it
 * in a food-court queue at peak, which is why the event picks.
 *
 * The cashier cannot type a price, a balance, or a card number anywhere on
 * this screen. The server prices the basket and the server owns the wallet.
 */
export function PosTerminal({
  stores,
  simulatorCards,
  terminalId,
  posFlow,
  posTopUpLimit,
  canTillTopUp,
  canReturnToAdmin,
}: {
  stores: StoreOption[];
  simulatorCards: SimulatorCard[];
  terminalId: string | null;
  posFlow: 'RING_FIRST' | 'TAP_FIRST';
  posTopUpLimit: number;
  canTillTopUp: boolean;
  /** Admins arrive here from the console and need a way back that is not
   *  signing out; a cashier on a shift has nowhere else to be. */
  canReturnToAdmin: boolean;
}): React.ReactElement {
  const tapFirst = posFlow === 'TAP_FIRST';
  const [storeId, setStoreId] = useState(stores[0]?.id ?? '');
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(false);
  const [basket, setBasket] = useState<Record<string, number>>({});
  const [stage, setStage] = useState<Stage>(tapFirst ? 'waiting' : 'ringing');
  const [holder, setHolder] = useState<ResolvedCard | null>(null);
  const [toppingUp, setToppingUp] = useState(false);
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

  const remaining = holder ? holder.balance - total : null;
  const shortfall = remaining !== null && remaining < 0 ? -remaining : 0;

  function startNextCustomer(): void {
    setBasket({});
    setReceipt(null);
    setError(null);
    setHolder(null);
    setToppingUp(false);
    setStage(tapFirst ? 'waiting' : 'ringing');
  }

  /** Read the card before anything is rung up, so the balance guides the basket. */
  const identify = useCallback(
    async (credential: CardCredential) => {
      if (stage !== 'waiting') return;
      setStage('charging');
      setError(null);
      try {
        setHolder(
          await api<ResolvedCard>('/api/cards/resolve', {
            method: 'POST',
            body: { ...credential, storeId, terminalId },
          }),
        );
        setStage('ringing');
      } catch (failure) {
        setError(
          failure instanceof ApiError ? failure.message : 'That card could not be read.',
        );
        setStage('waiting');
      }
    },
    [stage, storeId, terminalId],
  );

  /**
   * Charge a card that has already been read.
   *
   * No second tap: the customer presented the card at the start of the sale and
   * asking again is how a tap-first till loses the time it just spent.
   */
  const chargeHolder = useCallback(async () => {
    if (!holder || lines.length === 0 || stage !== 'ringing') return;
    setStage('charging');
    setError(null);
    try {
      setReceipt(
        await submitWithRetry<Receipt>(
          '/api/purchases',
          { storeId, userId: holder.userId, cardId: holder.cardId, terminalId, lines },
          newIdempotencyKey(),
        ),
      );
      setStage('done');
    } catch (failure) {
      setError(
        failure instanceof ApiError
          ? failure.message
          : 'The charge did not go through. Try again.',
      );
      setStage('ringing');
    }
  }, [holder, lines, stage, storeId, terminalId]);

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

  // Readers hand back a plain callback, so the async work is kicked off rather
  // than awaited here; every failure is already surfaced as state.
  const onTap = useCallback(
    (credential: CardCredential) => {
      if (tapFirst) void identify(credential);
      else void charge(credential);
    },
    [charge, identify, tapFirst],
  );

  // Ring-first arms the reader only while there is something to charge, so a
  // stray tap against a resting terminal can never move money. Tap-first arms
  // it only while waiting, where a tap identifies and cannot spend at all.
  const reader = useCardReader(onTap, {
    enabled: tapFirst ? stage === 'waiting' : stage === 'ringing' && lines.length > 0,
  });

  if (stage === 'done' && receipt) {
    return <PaidScreen receipt={receipt} onNext={startNextCustomer} />;
  }

  if (tapFirst && (stage === 'waiting' || (stage === 'charging' && holder === null))) {
    return (
      <div className="flex min-h-screen flex-col bg-ink-100">
        <header className="flex items-center justify-between border-b border-ink-200 bg-white px-4 py-3">
          <p className="text-sm font-bold text-ink-900">{store?.name ?? 'No store'}</p>
          <span className="flex items-center gap-2">
            {canReturnToAdmin ? (
            <Link
              href="/admin"
              className="rounded-lg px-2 py-2 text-sm font-medium text-brand-600 hover:bg-ink-50"
            >
              Console
            </Link>
          ) : null}
          <SignOutButton confirmWhen={false} />
          </span>
        </header>

        <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-4 p-4">
          {error ? (
            <Alert tone="danger" title="Not read">
              {error}
            </Alert>
          ) : null}

          <div className="text-center">
            <h1 className="text-xl font-bold text-ink-900">Tap the card to start</h1>
            <p className="mt-1 text-sm text-ink-500">
              The balance shows before anything is rung up.
            </p>
          </div>

          {stage === 'charging' ? (
            <Card className="flex justify-center py-10">
              <Spinner label="Reading the card" />
            </Card>
          ) : (
            <TapPanel reader={reader} onManualEntry={onTap} busy={false} />
          )}

          {simulatorCards.length > 0 && reader.simulate ? (
            <div className="flex flex-wrap justify-center gap-2">
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
        </main>
      </div>
    );
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
          <span className="flex items-center gap-2">
            {lines.length > 0 ? (
              <Button size="sm" tone="neutral" onClick={() => setBasket({})}>
                Clear
              </Button>
            ) : null}
            {holder ? (
              <Button size="sm" tone="neutral" onClick={startNextCustomer}>
                Cancel sale
              </Button>
            ) : null}
            {canReturnToAdmin ? (
            <Link
              href="/admin"
              className="rounded-lg px-2 py-2 text-sm font-medium text-brand-600 hover:bg-ink-50"
            >
              Console
            </Link>
          ) : null}
          {/* Shift change happens at the counter, so the way out lives here. */}
            <SignOutButton confirmWhen={lines.length > 0} />
          </span>
        </div>

        {holder ? (
          <div className="mx-auto mt-3 flex max-w-3xl items-center justify-between gap-3 rounded-xl bg-ink-50 px-3 py-2">
            <span className="min-w-0">
              <p className="truncate text-sm font-semibold text-ink-900">{holder.displayName}</p>
              <p className="tabular text-xs text-ink-400">{holder.cardRef}</p>
            </span>
            <span className="text-right">
              <p className="text-xs uppercase tracking-wide text-ink-500">Balance</p>
              <Points value={holder.balance} />
            </span>
          </div>
        ) : null}
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
              // Marked, not disabled: the cashier may still want it and drop
              // something else, and a dead button explains nothing.
              const overBalance = remaining !== null && product.pricePoints > remaining;

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
                    ) : overBalance ? (
                      <span className="text-xs font-semibold text-warn-800">Over balance</span>
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

          {holder && remaining !== null ? (
            <div className="mb-3 flex items-baseline justify-between border-t border-ink-100 pt-3">
              <span className="text-sm font-semibold uppercase tracking-wide text-ink-500">
                {shortfall > 0 ? 'Short by' : 'Left after this'}
              </span>
              <Points value={shortfall > 0 ? shortfall : remaining} />
            </div>
          ) : null}

          {toppingUp && holder ? (
            <TillTopUpSheet
              holder={holder}
              suggested={Math.min(shortfall, posTopUpLimit)}
              limit={posTopUpLimit}
              storeId={storeId}
              terminalId={terminalId}
              onCancel={() => setToppingUp(false)}
              onLoaded={(balance) => {
                setHolder({ ...holder, balance });
                setToppingUp(false);
              }}
            />
          ) : stage === 'charging' ? (
            <div className="flex items-center justify-center rounded-2xl bg-brand-50 py-6">
              <Spinner label="Charging the card" />
            </div>
          ) : lines.length === 0 ? (
            <p className="rounded-2xl bg-ink-50 py-6 text-center text-sm text-ink-500">
              {tapFirst ? 'Add items to the basket.' : 'Add items, then tap the card.'}
            </p>
          ) : tapFirst ? (
            shortfall > 0 ? (
              canTillTopUp && posTopUpLimit > 0 ? (
                <Button size="lg" fullWidth tone="warn" onClick={() => setToppingUp(true)}>
                  Add balance — short by {shortfall.toLocaleString()}
                </Button>
              ) : (
                <p className="rounded-2xl bg-warn-50 py-4 text-center text-sm font-semibold text-warn-800">
                  Short by {shortfall.toLocaleString()} points. Send them to the top-up desk.
                </p>
              )
            ) : (
              <Button size="lg" fullWidth onClick={() => void chargeHolder()}>
                Charge {total.toLocaleString()} points
              </Button>
            )
          ) : (
            <TapPanel reader={reader} onManualEntry={onTap} busy={false} />
          )}

          {!tapFirst && simulatorCards.length > 0 && reader.simulate ? (
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
 * Taking cash at the till, without leaving the sale.
 *
 * The amount defaults to exactly the shortfall, because that is what the
 * customer is being asked for and rounding it up is the cashier deciding to
 * hold someone else's money. The PIN is asked for every time: the terminal is
 * signed in for a whole shift, so the PIN is the only thing that ties a minted
 * point to a person.
 */
function TillTopUpSheet({
  holder,
  suggested,
  limit,
  storeId,
  terminalId,
  onCancel,
  onLoaded,
}: {
  holder: ResolvedCard;
  suggested: number;
  limit: number;
  storeId: string;
  terminalId: string | null;
  onCancel: () => void;
  onLoaded: (balance: number) => void;
}): React.ReactElement {
  const [amount, setAmount] = useState(Math.max(1, suggested));
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const presets = [suggested, 100, 250, 500, 1_000].filter(
    (value, index, all) => value > 0 && value <= limit && all.indexOf(value) === index,
  );

  async function load(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ recipients: { balanceAfter: number }[] }>('/api/pos/top-up', {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
        body: { userId: holder.userId, amountPoints: amount, storeId, terminalId, pin },
      });
      const balance = result.recipients[0]?.balanceAfter;
      if (balance === undefined) throw new ApiError(500, 'no_balance', 'No balance came back.');
      onLoaded(balance);
    } catch (failure) {
      setError(
        failure instanceof ApiError ? failure.message : 'That top-up did not go through.',
      );
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-3">
      <div className="flex items-baseline justify-between">
        <p className="text-sm font-bold text-ink-900">Add balance</p>
        <p className="text-xs text-ink-500">Limit {limit.toLocaleString()} per top-up</p>
      </div>

      {error ? (
        <Alert tone="danger" title="Not loaded">
          {error}
        </Alert>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {presets.map((preset) => (
          <Button
            key={preset}
            size="sm"
            tone={amount === preset ? 'brand' : 'neutral'}
            onClick={() => setAmount(preset)}
          >
            {preset.toLocaleString()}
          </Button>
        ))}
      </div>

      <div className="flex gap-2">
        <input
          type="number"
          min={1}
          max={limit}
          value={amount}
          aria-label="Top-up amount"
          onChange={(event) =>
            setAmount(Math.max(0, Math.min(limit, Number(event.target.value))))
          }
          className="tabular w-full rounded-xl border border-ink-300 px-3 py-2.5 text-sm"
        />
        <input
          type="password"
          inputMode="numeric"
          autoComplete="off"
          placeholder="Staff PIN"
          aria-label="Staff PIN"
          value={pin}
          onChange={(event) => setPin(event.target.value)}
          className="tabular w-32 rounded-xl border border-ink-300 px-3 py-2.5 text-sm"
        />
      </div>

      {busy ? (
        <div className="flex justify-center py-3">
          <Spinner label="Loading the card" />
        </div>
      ) : (
        <div className="flex gap-2">
          <Button fullWidth tone="neutral" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            fullWidth
            disabled={amount < 1 || amount > limit || pin.length < 4}
            onClick={() => void load()}
          >
            Load {amount.toLocaleString()}
          </Button>
        </div>
      )}
    </Card>
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
