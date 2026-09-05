import type { CardCredential } from './credentials';

/**
 * The hardware abstraction.
 *
 * Business logic depends on this interface and never on a specific reader.
 * Swapping a USB reader for phone NFC, or adding a dedicated terminal later,
 * means adding an implementation here — no service, route or database change.
 *
 * Every implementation emits the same `CardCredential` and every credential
 * goes to the same `POST /api/cards/resolve`. There is no bypass path, which
 * is why the development simulator is safe to ship: it exercises the real
 * authorisation and wallet logic, it just produces the credential differently.
 */
export interface NFCReader {
  readonly id: ReaderId;
  readonly label: string;
  /** Whether this reader can run in the current browser/device right now. */
  isSupported(): Promise<boolean>;
  /** Begin listening. Returns a function that stops listening. */
  start(handlers: ReaderHandlers): Promise<() => void>;
}

export type ReaderId = 'web-nfc' | 'keyboard-wedge' | 'simulator';

export interface ReaderHandlers {
  onCredential: (credential: CardCredential) => void;
  onError?: (error: Error) => void;
  /** Fired when the reader is armed and genuinely waiting for a tap. */
  onReady?: () => void;
}

export interface ReaderCapabilities {
  id: ReaderId;
  label: string;
  supported: boolean;
  description: string;
}
