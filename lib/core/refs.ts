import { sql } from 'drizzle-orm';
import type { Executor } from '../db/client';

/**
 * Human-friendly document references, e.g. TXN-2026-000123.
 *
 * Backed by Postgres sequences. nextval() takes no lock, so thousands of
 * concurrent checkouts do not serialise behind a counter. The trade-off is
 * that a rolled-back transaction burns a number and leaves a gap — which is
 * standard for financial document numbering and preferable to a bottleneck.
 */
const SEQUENCES = {
  ledgerTransaction: { sequence: 'ledger_txn_ref_seq', prefix: 'TXN' },
  purchase: { sequence: 'purchase_ref_seq', prefix: 'PUR' },
  refund: { sequence: 'refund_ref_seq', prefix: 'REF' },
  topup: { sequence: 'topup_ref_seq', prefix: 'TOP' },
  transfer: { sequence: 'transfer_ref_seq', prefix: 'TRF' },
  card: { sequence: 'card_ref_seq', prefix: 'CARD' },
  participant: { sequence: 'participant_ref_seq', prefix: 'P' },
  terminal: { sequence: 'terminal_ref_seq', prefix: 'POS' },
} as const;

export type RefKind = keyof typeof SEQUENCES;

export async function nextRef(db: Executor, kind: RefKind): Promise<string> {
  const { sequence, prefix } = SEQUENCES[kind];
  const result = await db.execute<{ value: string }>(
    sql`select nextval(${sequence})::text as value`,
  );
  const value = Number(result.rows[0]?.value ?? 0);
  const year = new Date().getUTCFullYear();
  return `${prefix}-${year}-${String(value).padStart(6, '0')}`;
}

/** Batch variant, so seeding thousands of cards is one round trip. */
export async function nextRefs(db: Executor, kind: RefKind, count: number): Promise<string[]> {
  if (count <= 0) return [];
  const { sequence, prefix } = SEQUENCES[kind];
  const result = await db.execute<{ value: string }>(
    sql`select nextval(${sequence})::text as value from generate_series(1, ${count})`,
  );
  const year = new Date().getUTCFullYear();
  return result.rows.map((row) => `${prefix}-${year}-${String(Number(row.value)).padStart(6, '0')}`);
}
