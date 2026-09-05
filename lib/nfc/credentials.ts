import { z } from 'zod';

/**
 * A credential presented at a terminal. This is the ONLY vocabulary the
 * business layer understands, which is what lets the reader hardware change
 * without touching a single service.
 *
 * - TOKEN      the secret written to the card's NDEF. Preferred.
 * - UID        the chip serial. Readable and clonable by any phone; accepted
 *              only when the event explicitly allows it.
 * - MANUAL_REF a staff member typing the printed card reference. Audited.
 */
export type CredentialKind = 'TOKEN' | 'UID' | 'MANUAL_REF';

export interface CardCredential {
  kind: CredentialKind;
  value: string;
}

export const cardCredentialSchema = z.object({
  kind: z.enum(['TOKEN', 'UID', 'MANUAL_REF']),
  value: z.string().min(1).max(512),
});

/** Chip UIDs vary in length and separator style between readers. Normalise. */
export function normaliseUid(raw: string): string {
  return raw.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
}

export function isPlausibleUid(raw: string): boolean {
  const normalised = normaliseUid(raw);
  // 4-byte through 10-byte UIDs cover every common NFC tag family.
  return normalised.length >= 8 && normalised.length <= 20 && normalised.length % 2 === 0;
}
