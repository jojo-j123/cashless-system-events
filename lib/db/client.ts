import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

/**
 * Points are bigint in Postgres. node-postgres returns bigint as a string by
 * default to avoid silent precision loss. Our amounts are far below 2^53, and
 * Drizzle's `{ mode: 'number' }` promises a number, so parse them here rather
 * than sprinkling Number() across the services.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number.parseInt(value, 10));
// NUMERIC, used by SUM() over bigint in report queries.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value) => Number.parseFloat(value));

export type Database = NodePgDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
/** Anything that can run queries: the pool, or an open transaction. */
export type Executor = Database | Transaction;

let pool: pg.Pool | undefined;
let database: Database | undefined;

function connectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
  }
  return url;
}

/**
 * How many connections this process may hold.
 *
 * On a long-lived server one process serves every request, so a real pool is
 * what you want. On a serverless platform the arithmetic inverts: each
 * concurrent function instance builds its own pool, so `max` is multiplied by
 * peak concurrency rather than shared across it. Twenty connections per
 * instance is a self-inflicted outage at the busiest moment of the event — the
 * pooler starts refusing connections precisely when every bar is queueing.
 *
 * So default to 1 under serverless and let the platform's pooler do the
 * multiplexing it exists to do. `DB_POOL_MAX` still overrides either way.
 */
function poolMax(): number {
  const explicit = process.env.DB_POOL_MAX;
  if (explicit) return Number(explicit);
  const isServerless = Boolean(process.env.VERCEL ?? process.env.AWS_LAMBDA_FUNCTION_NAME);
  return isServerless ? 1 : 20;
}

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: connectionString(),
      max: poolMax(),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      // Checkout holds row locks; a runaway query must not pin them forever.
      statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS ?? 15_000),
    });
    pool.on('error', (error) => {
      console.error(JSON.stringify({ level: 'error', msg: 'pg pool error', error: error.message }));
    });
  }
  return pool;
}

export function getDb(): Database {
  if (!database) {
    database = drizzle(getPool(), { schema, casing: 'snake_case' });
  }
  return database;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
    database = undefined;
  }
}

/**
 * Whether an error is a Postgres unique-constraint violation (SQLSTATE 23505).
 *
 * The driver's error is not what reaches the caller: the query builder wraps it
 * and hangs the original off `cause`, so a check against the outermost error
 * alone silently never matches and a race surfaces as a raw database failure
 * instead of the conflict it is. Walking the chain is what makes
 * insert-and-catch usable as a concurrency guard.
 */
export function isUniqueViolation(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current != null && depth < 8; depth += 1) {
    if (typeof current === 'object' && (current as { code?: unknown }).code === '23505') {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export { schema };
