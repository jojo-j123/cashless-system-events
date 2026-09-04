import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { closeDb, getDb } from '../lib/db/client';
import { syncRolesAndPermissions } from '../lib/db/bootstrap';

/**
 * Wipe every row while leaving the schema in place, then restore reference data.
 *
 * Truncate rather than drop: migrations stay applied, so this is safe to run
 * against an environment whose schema is already at head — which is the case
 * that matters, clearing a rehearsal before the real event.
 *
 * Roles and permissions are reference data rather than event data, so they are
 * left alone and re-synced; every table that carries money, cards or audit
 * history is emptied.
 */

const CONFIRMATION = 'yes-wipe-everything';

async function main(): Promise<void> {
  if (process.env.CONFIRM_RESET !== CONFIRMATION) {
    throw new Error(
      `Refusing to wipe the database. This deletes every wallet, ledger entry, ` +
        `card and audit record in ${describeTarget()}. ` +
        `Re-run with CONFIRM_RESET=${CONFIRMATION} if that is genuinely what you want.`,
    );
  }

  const db = getDb();

  const { rows } = await db.execute<{ tablename: string }>(sql`
    select tablename from pg_tables
     where schemaname = 'public'
       and tablename not in ('roles', 'permissions', 'role_permissions')
     order by tablename
  `);

  if (rows.length === 0) {
    throw new Error(
      'No application tables found in the public schema. Run migrations first: npm run db:migrate',
    );
  }

  const tables = rows.map((row) => `"${row.tablename}"`).join(', ');
  console.log(`→ Truncating ${rows.length} tables in ${describeTarget()}`);
  await db.execute(sql.raw(`truncate ${tables} restart identity cascade`));

  // Human-facing refs (receipts, cards) count from 1 again, so a cleared
  // rehearsal does not leave the real event starting at #4,000.
  console.log('→ Restarting reference sequences');
  await db.execute(sql`
    select setval(c.oid, 1, false)
      from pg_class c
     where c.relkind = 'S' and c.relname like '%_ref_seq'
  `);

  console.log('→ Restoring roles and permissions');
  await syncRolesAndPermissions(db);

  console.log(`\nDone. ${rows.length} tables emptied; roles and permissions kept.`);
  console.log('Seed it again with: npm run db:seed');
}

/** Host and database only — never the credentials. */
function describeTarget(): string {
  const url = process.env.DATABASE_URL;
  if (!url) return 'the configured database';
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}`;
  } catch {
    return 'the configured database';
  }
}

main()
  .then(() => closeDb())
  .catch(async (error) => {
    console.error(JSON.stringify({ level: 'error', msg: error.message, code: error.code }));
    await closeDb().catch(() => {});
    process.exit(1);
  });
