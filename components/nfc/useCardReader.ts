'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CardCredential } from '@/lib/nfc/credentials';
import type { NFCReader, ReaderCapabilities, ReaderId } from '@/lib/nfc/reader';
import {
  KeyboardWedgeReader,
  SimulatorReader,
  WebNFCReader,
} from './readers';

export interface CardReaderState {
  readers: ReaderCapabilities[];
  activeReaderId: ReaderId | null;
  status: 'idle' | 'starting' | 'listening' | 'error';
  error: string | null;
  selectReader: (id: ReaderId) => void;
  /** Available only when the simulator is the active reader. */
  simulate: ((credential: CardCredential) => void) | null;
}

const DESCRIPTIONS: Record<ReaderId, string> = {
  'web-nfc': 'Tap a card against the back of this phone.',
  'keyboard-wedge': 'Use a USB reader that types the card value.',
  simulator: 'Development only. Runs the same server-side checks as a real tap.',
  'qr-camera': 'Scan a participant QR code with the camera.',
};

/**
 * Binds a reader to a callback.
 *
 * The hook picks whichever reader the device actually supports, and every
 * reader hands back the same `CardCredential`. Nothing downstream knows or
 * cares which hardware produced it.
 */
export function useCardReader(
  onCredential: (credential: CardCredential) => void,
  options: { enabled?: boolean } = {},
): CardReaderState {
  const enabled = options.enabled ?? true;
  const [readers, setReaders] = useState<ReaderCapabilities[]>([]);
  const [activeReaderId, setActiveReaderId] = useState<ReaderId | null>(null);
  const [status, setStatus] = useState<CardReaderState['status']>('idle');
  const [error, setError] = useState<string | null>(null);

  const instances = useRef<Map<ReaderId, NFCReader>>(new Map());
  const stopRef = useRef<(() => void) | null>(null);
  // Kept in a ref so re-arming the reader is not triggered by every render.
  const callbackRef = useRef(onCredential);
  callbackRef.current = onCredential;

  useEffect(() => {
    let cancelled = false;

    const detect = async (): Promise<void> => {
      const candidates: NFCReader[] = [
        new WebNFCReader(),
        new KeyboardWedgeReader(),
        new SimulatorReader(),
      ];
      const capabilities: ReaderCapabilities[] = [];

      for (const reader of candidates) {
        instances.current.set(reader.id, reader);
        capabilities.push({
          id: reader.id,
          label: reader.label,
          supported: await reader.isSupported(),
          description: DESCRIPTIONS[reader.id],
        });
      }

      if (cancelled) return;
      setReaders(capabilities);
      // Prefer real hardware; the simulator is only ever a last resort.
      const preferred =
        capabilities.find((entry) => entry.id === 'web-nfc' && entry.supported) ??
        capabilities.find((entry) => entry.id === 'keyboard-wedge' && entry.supported) ??
        capabilities.find((entry) => entry.supported);
      setActiveReaderId((current) => current ?? preferred?.id ?? null);
    };

    void detect();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!enabled || !activeReaderId) return undefined;
    const reader = instances.current.get(activeReaderId);
    if (!reader) return undefined;

    let disposed = false;
    setStatus('starting');
    setError(null);

    void reader
      .start({
        onCredential: (credential) => callbackRef.current(credential),
        onReady: () => {
          if (!disposed) setStatus('listening');
        },
        onError: (readerError) => {
          if (!disposed) setError(readerError.message);
        },
      })
      .then((stop) => {
        if (disposed) {
          stop();
          return;
        }
        stopRef.current = stop;
      })
      .catch((startError: unknown) => {
        if (disposed) return;
        setStatus('error');
        setError(startError instanceof Error ? startError.message : 'The reader could not start.');
      });

    return () => {
      disposed = true;
      stopRef.current?.();
      stopRef.current = null;
    };
  }, [activeReaderId, enabled]);

  const selectReader = useCallback((id: ReaderId) => {
    setActiveReaderId(id);
  }, []);

  const simulator = instances.current.get('simulator');
  const simulate =
    activeReaderId === 'simulator' && simulator instanceof SimulatorReader
      ? (credential: CardCredential) => simulator.simulate(credential)
      : null;

  return { readers, activeReaderId, status, error, selectReader, simulate };
}
