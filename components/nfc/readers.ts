'use client';

import type { CardCredential } from '@/lib/nfc/credentials';
import type { NFCReader, ReaderHandlers } from '@/lib/nfc/reader';

/**
 * Web NFC (Chrome on Android).
 *
 * Reads the NDEF text record written to the card, which holds the server-issued
 * secret token. The chip serial is deliberately NOT used: it is readable and
 * clonable by any phone, so it is a weak credential and the server only accepts
 * it when an operator has explicitly opted in.
 */
export class WebNFCReader implements NFCReader {
  readonly id = 'web-nfc' as const;
  readonly label = 'Phone NFC';

  async isSupported(): Promise<boolean> {
    return typeof window !== 'undefined' && 'NDEFReader' in window;
  }

  async start(handlers: ReaderHandlers): Promise<() => void> {
    const NDEFReaderCtor = (window as unknown as { NDEFReader?: new () => NdefReader }).NDEFReader;
    if (!NDEFReaderCtor) throw new Error('This device or browser does not support NFC.');

    const reader = new NDEFReaderCtor();
    const controller = new AbortController();

    reader.addEventListener('reading', (event: Event) => {
      const ndef = event as unknown as NdefReadingEvent;
      const token = extractToken(ndef);
      if (token) {
        handlers.onCredential({ kind: 'TOKEN', value: token });
        return;
      }
      // No token on the tag — fall back to the serial and let the server
      // decide whether this event accepts it.
      if (ndef.serialNumber) {
        handlers.onCredential({ kind: 'UID', value: ndef.serialNumber });
      }
    });

    reader.addEventListener('readingerror', () => {
      handlers.onError?.(new Error('Could not read that card. Try again.'));
    });

    try {
      await reader.scan({ signal: controller.signal });
      handlers.onReady?.();
    } catch (error) {
      throw new Error(
        error instanceof Error && error.name === 'NotAllowedError'
          ? 'NFC permission was denied. Allow it in the browser and try again.'
          : 'NFC could not be started on this device.',
      );
    }

    return () => controller.abort();
  }
}

function extractToken(event: NdefReadingEvent): string | null {
  for (const record of event.message?.records ?? []) {
    if (record.recordType !== 'text' || !record.data) continue;
    try {
      const text = new TextDecoder(record.encoding ?? 'utf-8').decode(record.data);
      const trimmed = text.trim();
      if (trimmed.length > 0) return trimmed;
    } catch {
      // Unreadable record; try the next one.
    }
  }
  return null;
}

/**
 * USB reader in keyboard-wedge mode.
 *
 * The most common hardware at real events: the reader behaves as a keyboard,
 * typing the value and pressing Enter. Nothing to install, works on any
 * desktop or tablet with a USB port.
 */
export class KeyboardWedgeReader implements NFCReader {
  readonly id = 'keyboard-wedge' as const;
  readonly label = 'USB card reader';

  async isSupported(): Promise<boolean> {
    return typeof document !== 'undefined';
  }

  async start(handlers: ReaderHandlers): Promise<() => void> {
    let buffer = '';
    let lastKeyAt = 0;

    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      // Never swallow what someone is deliberately typing into a field.
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;

      const now = Date.now();
      // A human cannot type this fast; a gap means a new scan started.
      if (now - lastKeyAt > 120) buffer = '';
      lastKeyAt = now;

      if (event.key === 'Enter') {
        const value = buffer.trim();
        buffer = '';
        if (value.length >= 4) {
          handlers.onCredential({ kind: detectKind(value), value });
        }
        return;
      }

      if (event.key.length === 1) buffer += event.key;
    };

    document.addEventListener('keydown', onKeyDown);
    handlers.onReady?.();
    return () => document.removeEventListener('keydown', onKeyDown);
  }
}

/** A wedge reader may be configured to send a token, a UID, or a QR payload. */
function detectKind(value: string): CardCredential['kind'] {
  if (value.startsWith('CQ1.')) return 'QR';
  if (/^CARD-\d{4}-\d{6}$/i.test(value)) return 'MANUAL_REF';
  if (/^[0-9a-fA-F:\- ]{8,23}$/.test(value)) return 'UID';
  return 'TOKEN';
}

/**
 * Development simulator.
 *
 * NOT a bypass. It produces a real credential from a real card and submits it
 * to the same endpoint, so authorisation, card status checks and wallet logic
 * all run exactly as they do with physical hardware. It is gated behind an
 * environment flag and must be off in production.
 */
export class SimulatorReader implements NFCReader {
  readonly id = 'simulator' as const;
  readonly label = 'Simulated tap (development)';

  private listener: ((credential: CardCredential) => void) | null = null;

  async isSupported(): Promise<boolean> {
    return process.env.NEXT_PUBLIC_ENABLE_NFC_SIMULATOR === 'true';
  }

  async start(handlers: ReaderHandlers): Promise<() => void> {
    this.listener = handlers.onCredential;
    handlers.onReady?.();
    return () => {
      this.listener = null;
    };
  }

  /** Called by the simulator UI when a staff member picks a card to "tap". */
  simulate(credential: CardCredential): void {
    this.listener?.(credential);
  }
}

export function availableReaders(): NFCReader[] {
  return [new WebNFCReader(), new KeyboardWedgeReader(), new SimulatorReader()];
}

/* -- Minimal Web NFC typings; the DOM lib does not ship them yet ----------- */
interface NdefReader {
  scan(options?: { signal?: AbortSignal }): Promise<void>;
  addEventListener(type: string, listener: (event: Event) => void): void;
}

interface NdefRecord {
  recordType: string;
  encoding?: string;
  data?: BufferSource;
}

interface NdefReadingEvent {
  serialNumber?: string;
  message?: { records: NdefRecord[] };
}
