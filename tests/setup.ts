import 'dotenv/config';

/**
 * Tests run against a real PostgreSQL database, not a mock.
 *
 * This is not optional for this project: the guarantees that matter here —
 * row locking, deadlock avoidance, CHECK constraints, deferred triggers — do
 * not exist in a fake, and the bugs they prevent only appear under real
 * concurrency.
 */
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/cashless_test';

process.env.APP_SECRET ??= 'test-secret-with-more-than-thirty-two-characters-ok';
// NODE_ENV is set by the vitest runner itself.
