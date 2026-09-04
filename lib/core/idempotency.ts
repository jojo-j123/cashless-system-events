import { createHash } from 'node:crypto';
import { and, eq, lt, sql } from 'drizzle-orm';
import type { Database, Transaction } from '../db/client';
import { idempotencyKeys } from '../db/schema';
import { IdempotencyConflictError, RequestInProgressError } from '../errors';

const RETENTION_HOURS = 48;

export function hashRequest(body: unknown): string {
  return createHash('sha256').update(canonicalise(body), 'utf8').digest('hex');
}

/** Stable JSON: key order must not change the hash. */
function canonicalise(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalise(nested)}`);
  return `{${entries.join(',')}}`;
}

export interface IdempotentResult<T> {
  value: T;
  /** True when this call returned a previously stored result. */
  replayed: boolean;
}

/**
 * Run `work` at most once for a given (scope, key).
 *
 * The key is claimed inside the same database transaction as the work, so
 * there is no window in which the work committed but the key did not. That is
 * the property that makes a POS safe to retry over a flaky network.
 *
 * Replaying the same key with a *different* body is a 409 rather than a silent
 * "pick one": that combination is always a client bug, and failing loudly is
 * the safer outcome when points are involved.
 */
export async function withIdempotency<T>(
  db: Database,
  options: {
    scope: string;
    key: string;
    actorUserId: string | null;
    requestBody: unknown;
  },
  work: (tx: Transaction) => Promise<{ value: T; resourceType?: string; resourceId?: string }>,
): Promise<IdempotentResult<T>> {
  const requestHash = hashRequest(options.requestBody);

  const existing = await findExisting(db, options.scope, options.key);
  if (existing) {
    return { value: assertReusable<T>(existing, requestHash), replayed: true };
  }

  try {
    return await db.transaction(async (tx) => {
      // Claim the key first. A concurrent identical request loses this race
      // and surfaces as a unique-violation, handled below.
      await tx.insert(idempotencyKeys).values({
        scope: options.scope,
        key: options.key,
        actorUserId: options.actorUserId,
        requestHash,
        status: 'IN_PROGRESS',
        expiresAt: new Date(Date.now() + RETENTION_HOURS * 3_600_000),
      });

      const outcome = await work(tx);

      await tx
        .update(idempotencyKeys)
        .set({
          status: 'COMPLETED',
          responseStatus: 200,
          responseBody: outcome.value as never,
          resourceType: outcome.resourceType ?? null,
          resourceId: outcome.resourceId ?? null,
          completedAt: new Date(),
        })
        .where(
          and(eq(idempotencyKeys.scope, options.scope), eq(idempotencyKeys.key, options.key)),
        );

      return { value: outcome.value, replayed: false };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Someone else claimed the key between our check and our insert.
      const concurrent = await findExisting(db, options.scope, options.key);
      if (concurrent) {
        return { value: assertReusable<T>(concurrent, requestHash), replayed: true };
      }
      throw new RequestInProgressError();
    }
    throw error;
  }
}

type StoredKey = typeof idempotencyKeys.$inferSelect;

async function findExisting(
  db: Database,
  scope: string,
  key: string,
): Promise<StoredKey | undefined> {
  const [row] = await db
    .select()
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)))
    .limit(1);
  return row;
}

function assertReusable<T>(record: StoredKey, requestHash: string): T {
  if (record.requestHash !== requestHash) {
    throw new IdempotencyConflictError();
  }
  if (record.status !== 'COMPLETED' || record.responseBody === null) {
    // The original attempt is still running, or rolled back without releasing
    // the key. Either way the client should retry rather than get a wrong answer.
    throw new RequestInProgressError();
  }
  return record.responseBody as T;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}

/** Housekeeping: drop expired keys. Safe to run on a schedule. */
export async function pruneIdempotencyKeys(db: Database): Promise<number> {
  const result = await db
    .delete(idempotencyKeys)
    .where(lt(idempotencyKeys.expiresAt, sql`now()`))
    .returning({ id: idempotencyKeys.id });
  return result.length;
}
