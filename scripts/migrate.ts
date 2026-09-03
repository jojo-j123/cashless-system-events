import 'dotenv/config';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { closeDb, getDb } from '../lib/db/client';

async function main(): Promise<void> {
  const db = getDb();
  console.log('Running migrations...');
  await migrate(db, { migrationsFolder: './lib/db/migrations' });
  console.log('Migrations complete.');
  await closeDb();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
