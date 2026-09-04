import { sql } from 'drizzle-orm';
import type { Executor } from '../db/client';
import { RateLimitedError } from '../errors';

export interface RateLimitRule {
  /** Identifies what is being limited, e.g. 'login', 'card-tap'. */
  name: string;
  limit: number;
  windowSeconds: number;
}

export interface RateLimitOutcome {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Fixed-window counter held in Postgres rather than memory, so the limit is
 * real across multiple app instances. A single UPSERT does the whole thing:
 * the window is bucketed by truncating the clock, and a new bucket key means
 * the counter naturally resets.
 */
export async function consumeRateLimit(
  db: Executor,
  rule: RateLimitRule,
  subject: string,
): Promise<RateLimitOutcome> {
  const windowMs = rule.windowSeconds * 1_000;
  const windowStartMs = Math.floor(Date.now() / windowMs) * windowMs;
  const windowStart = new Date(windowStartMs);
  const bucketKey = `${rule.name}:${subject}:${windowStartMs}`;
  const expiresAt = new Date(windowStartMs + windowMs * 2);

  const result = await db.execute<{ counter: number }>(sql`
    insert into rate_limit_buckets (bucket_key, window_start, counter, expires_at)
    values (${bucketKey}, ${windowStart.toISOString()}, 1, ${expiresAt.toISOString()})
    on conflict (bucket_key)
      do update set counter = rate_limit_buckets.counter + 1
    returning counter
  `);

  const counter = Number(result.rows[0]?.counter ?? 1);
  const retryAfterSeconds = Math.max(1, Math.ceil((windowStartMs + windowMs - Date.now()) / 1000));

  return {
    allowed: counter <= rule.limit,
    remaining: Math.max(0, rule.limit - counter),
    retryAfterSeconds,
  };
}

export async function enforceRateLimit(
  db: Executor,
  rule: RateLimitRule,
  subject: string,
  message?: string,
): Promise<void> {
  const outcome = await consumeRateLimit(db, rule, subject);
  if (!outcome.allowed) {
    throw new RateLimitedError(outcome.retryAfterSeconds, message);
  }
}

export const RATE_LIMITS = {
  login: { name: 'login', limit: 10, windowSeconds: 300 },
  cardTap: { name: 'card-tap', limit: 60, windowSeconds: 60 },
  cardTapPerCard: { name: 'card-tap-card', limit: 30, windowSeconds: 60 },
  purchase: { name: 'purchase', limit: 120, windowSeconds: 60 },
  transfer: { name: 'transfer', limit: 10, windowSeconds: 3_600 },
  mutation: { name: 'mutation', limit: 300, windowSeconds: 60 },
} as const satisfies Record<string, RateLimitRule>;

export async function pruneRateLimitBuckets(db: Executor): Promise<void> {
  await db.execute(sql`delete from rate_limit_buckets where expires_at < now()`);
}
