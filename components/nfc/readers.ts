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
/**
 * A USB wedge reader types the card number and presses Enter, character by
 * character, far faster than a person can. That speed is the only reliable
 * way to tell a scan from someone filling in a form — the reader is an
 * ordinary keyboard as far as the browser is concerned, and the operator's
 * hands are usually still in the name field when they present the card.
 */
const MACHINE_GAP_MS = 50;
const MIN_SCAN_LENGTH = 4;

export class KeyboardWedgeReader implements NFCReader {
  readonly id = 'keyboard-wedge' as const;
  readonly label = 'USB card reader';

  async isSupported(): Promise<boolean> {
    return typeof document !== 'undefined';
  }

  async start(handlers: ReaderHandlers): Promise<() => void> {
    let buffer = '';
    let lastKeyAt = 0;
    let fastKeys = 0;
    let borrowed: { element: HTMLInputElement; value: string } | null = null;

    const reset = (): void => {
      buffer = '';
      fastKeys = 0;
      borrowed = null;
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      const now = Date.now();
      const gap = now - lastKeyAt;
      lastKeyAt = now;

      if (event.key === 'Enter') {
        const value = buffer.trim();
        // A scan is a burst: nearly every character arrived faster than a
        // person can type. A human pressing Enter in a form is not.
        const scanned = value.length >= MIN_SCAN_LENGTH && fastKeys >= value.length - 1;
        const stolenFrom = borrowed;
        reset();

        if (!scanned) return;

        event.preventDefault();
        // The reader typed into whatever field had focus. Put that field back
        // exactly as the operator left it — through the native setter, so a
        // React-controlled input updates its state rather than silently
        // disagreeing with the DOM.
        if (stolenFrom) restoreValue(stolenFrom.element, stolenFrom.value);

        handlers.onCredential({ kind: detectKind(value), value });
        return;
      }

      if (event.key.length !== 1) return;

      // A character only continues the current sequence if it arrived at
      // machine speed. Anything slower starts a new one — including the first
      // character of a scan, which follows whatever the operator last typed.
      if (gap < MACHINE_GAP_MS && buffer.length > 0) {
        fastKeys += 1;
      } else {
        reset();
        // Snapshot the field as it stands before this character, in case the
        // sequence turns out to be a card. keydown runs before the value
        // changes, so this is the operator's own text, without the scan.
        const target = event.target;
        if (target instanceof HTMLInputElement) {
          borrowed = { element: target, value: target.value };
        }
      }

      buffer += event.key;
    };

    document.addEventListener('keydown', onKeyDown);
    handlers.onReady?.();
    return () => document.removeEventListener('keydown', onKeyDown);
  }
}

/**
 * Write a value into an input the way a user would, not the way JavaScript
 * does. React tracks the last value it set; assigning `.value` directly leaves
 * its state stale, so the field would snap back the next time it rendered.
 */
function restoreValue(element: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

/** A wedge reader may be configured to send a token, a UID, or a printed ref. */
function detectKind(value: string): CardCredential['kind'] {
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
