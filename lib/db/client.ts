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

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: connectionString(),
      max: Number(process.env.DB_POOL_MAX ?? 20),
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

export { schema };
