/**
 * Migration entrypoint.
 *
 * Plain ESM rather than TypeScript on purpose: this is the one script that must
 * run inside the production container, and shipping `tsx` (and its esbuild
 * binary) into a runtime image just to apply SQL is not a trade worth making.
 * It needs nothing beyond `pg` and `drizzle-orm`, both production dependencies.
 *
 * Concurrency: two app instances starting at once would otherwise both run the
 * migrator against the same database, and Drizzle's node-postgres migrator does
 * not lock. Interleaved DDL on a schema whose whole point is financial
 * integrity is not a risk worth carrying, so we take a session-level advisory
 * lock first. The second instance waits, then finds nothing left to apply.
 * If the process dies the lock dies with the session — no manual cleanup.
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

/** Arbitrary but fixed. Every instance of this app must use the same number. */
const MIGRATION_LOCK_KEY = 4021970120;
/** A migration run that cannot get the lock in this long means something is stuck. */
const LOCK_TIMEOUT_MS = 120_000;

const MIGRATIONS_FOLDER = './lib/db/migrations';

function log(msg, extra = {}) {
  console.log(JSON.stringify({ level: 'info', msg, ...extra }));
}

async function main() {
  // `DATABASE_URL` may point at a transaction-mode pooler (Supabase Supavisor on
  // :6543, PgBouncer, etc.), which is correct for the application — every
  // transaction runs start-to-finish on one pinned backend, so `FOR UPDATE` and
  // the deferred sum-to-zero trigger behave exactly as they do on a direct
  // connection.
  //
  // Migrations are the exception. `pg_advisory_lock` is *session*-scoped, and a
  // transaction-mode pooler hands the session back after each statement — the
  // lock would be taken and dropped immediately, and two concurrent migrators
  // would interleave DDL while both believing they held it. That failure is
  // silent, which is the worst kind. So migrations demand a session-capable
  // connection: `DIRECT_DATABASE_URL` when set, otherwise `DATABASE_URL`.
  // Treat blank as absent. GitHub Actions expands an unset secret to the empty
  // string rather than leaving the variable undefined, so `??` would hand us
  // "" and we would fail claiming nothing was configured while DATABASE_URL sat
  // there perfectly valid.
  const direct = (process.env.DIRECT_DATABASE_URL ?? '').trim();
  const fallback = (process.env.DATABASE_URL ?? '').trim();
  const connectionString = direct || fallback;

  if (!connectionString) {
    throw new Error(
      'No database connection configured. Set DIRECT_DATABASE_URL (preferred: a ' +
        'session-capable connection) or DATABASE_URL.',
    );
  }

  if (direct) {
    log('using DIRECT_DATABASE_URL for migrations (session-scoped advisory lock)');
  } else {
    log('DIRECT_DATABASE_URL not set; migrating via DATABASE_URL', {
      warning:
        'If DATABASE_URL points at a transaction-mode pooler, the advisory lock ' +
        'below cannot protect against concurrent migrators.',
    });
  }

  // A dedicated client, not a pool: an advisory lock belongs to the session
  // that took it, so it has to be held on one connection we control for the
  // whole run.
  const lockHolder = new pg.Client({ connectionString });
  await lockHolder.connect();

  const pool = new pg.Pool({ connectionString, max: 1 });

  try {
    await lockHolder.query(`SET lock_timeout = ${LOCK_TIMEOUT_MS}`);
    try {
      await lockHolder.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    } catch (error) {
      throw new Error(
        `Could not acquire the migration lock within ${LOCK_TIMEOUT_MS}ms. ` +
          'Another migration is running, or a previous one is stuck. ' +
          `Check: SELECT * FROM pg_locks WHERE locktype = 'advisory';`,
        { cause: error },
      );
    }

    log('migration lock acquired, applying migrations');
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
    log('migrations complete');
  } finally {
    // Best effort: the lock is released by the session ending regardless.
    await pool.end().catch(() => {});
    await lockHolder.end().catch(() => {});
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    level: 'error',
    msg: error.message,
    code: error.code,
    detail: error.detail,
  }));
  process.exit(1);
});
