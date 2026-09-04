'use client';

import { useState } from 'react';
import type { CardCredential } from '@/lib/nfc/credentials';
import type { CardReaderState } from './useCardReader';
import { Alert, Button, Card } from '@/components/ui/primitives';

/**
 * The waiting-for-a-tap surface.
 *
 * Deliberately large and calm: at a busy counter the cashier needs to know at
 * a glance whether the reader is armed, and the participant needs to see that
 * something happened when they tapped.
 */
export function TapPanel({
  reader,
  onManualEntry,
  busy,
}: {
  reader: CardReaderState;
  onManualEntry: (credential: CardCredential) => void;
  busy: boolean;
}): React.ReactElement {
  const [manualValue, setManualValue] = useState('');
  const [showManual, setShowManual] = useState(false);

  return (
    <Card className="flex flex-col items-center gap-6 py-12 text-center">
      <div
        aria-hidden
        className={`flex h-28 w-28 items-center justify-center rounded-full border-4 ${
          busy
            ? 'border-brand-400 bg-brand-50'
            : reader.status === 'listening'
              ? 'animate-pulse border-brand-500 bg-brand-50'
              : 'border-ink-300 bg-ink-50'
        }`}
      >
        <svg viewBox="0 0 24 24" className="h-12 w-12 text-brand-600" fill="none" strokeWidth={1.8}>
          <path
            d="M5 8a10 10 0 0 1 0 8M9 6a14 14 0 0 1 0 12M13 4.5a18 18 0 0 1 0 15"
            stroke="currentColor"
            strokeLinecap="round"
          />
        </svg>
      </div>

      <div>
        <h2 className="text-2xl font-bold text-ink-900">
          {busy ? 'Reading card…' : 'Tap NFC card'}
        </h2>
        <p className="mt-1 text-sm text-ink-500">
          {reader.status === 'listening'
            ? 'Ready. Hold the card against the reader.'
            : reader.status === 'starting'
              ? 'Starting the reader…'
              : 'No reader is active.'}
        </p>
      </div>

      {reader.error ? <Alert tone="warn" title={reader.error} /> : null}

      <div className="flex flex-wrap justify-center gap-2">
        {reader.readers.map((entry) => (
          <button
            key={entry.id}
            type="button"
            disabled={!entry.supported}
            onClick={() => reader.selectReader(entry.id)}
            title={entry.description}
            className={`rounded-full px-3 py-1.5 text-xs font-semibold ring-1 ring-inset transition
              disabled:cursor-not-allowed disabled:opacity-40
              ${
                reader.activeReaderId === entry.id
                  ? 'bg-brand-600 text-white ring-brand-600'
                  : 'bg-white text-ink-600 ring-ink-300 hover:bg-ink-50'
              }`}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {showManual ? (
        <form
          className="flex w-full max-w-sm gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const value = manualValue.trim();
            if (value.length === 0) return;
            onManualEntry({ kind: 'MANUAL_REF', value });
            setManualValue('');
          }}
        >
          <input
            value={manualValue}
            onChange={(event) => setManualValue(event.target.value)}
            placeholder="CARD-2026-000123"
            aria-label="Card reference"
            className="flex-1 rounded-xl border border-ink-300 px-4 py-3 text-base
              focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100"
          />
          <Button type="submit" tone="neutral">
            Look up
          </Button>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setShowManual(true)}
          className="text-sm font-medium text-brand-600 underline-offset-2 hover:underline"
        >
          Enter a card reference instead
        </button>
      )}
    </Card>
  );
}
