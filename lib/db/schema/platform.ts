import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  boolean,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  challengeStatus,
  idempotencyStatus,
  notificationSeverity,
  rewardType,
} from './enums';
import { events, users } from './identity';
import { ledgerTransactions } from './ledger';
import { products } from './commerce';

/**
 * Append-only audit trail. UPDATE and DELETE are blocked by trigger.
 * Written inside the same transaction as the action it records, so an
 * audit entry cannot exist for an action that rolled back, or vice versa.
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id').references(() => events.id, { onDelete: 'set null' }),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    actorRole: text('actor_role'),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: uuid('target_id'),
    beforeState: jsonb('before_state'),
    afterState: jsonb('after_state'),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    requestId: text('request_id'),
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_logs_event_time_idx').on(t.eventId, t.createdAt),
    index('audit_logs_actor_idx').on(t.actorUserId, t.createdAt),
    index('audit_logs_target_idx').on(t.targetType, t.targetId),
    index('audit_logs_action_idx').on(t.action, t.createdAt),
  ],
);

/**
 * Idempotency records. A key is claimed inside the same transaction as the
 * work it guards, so a crash between "work committed" and "key recorded" is
 * impossible.
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Endpoint identity, so the same key on two endpoints does not collide. */
    scope: text('scope').notNull(),
    key: text('key').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** SHA-256 of the canonical request body. Mismatch on replay is a 409. */
    requestHash: text('request_hash').notNull(),
    status: idempotencyStatus('status').notNull().default('IN_PROGRESS'),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body'),
    resourceType: text('resource_type'),
    resourceId: uuid('resource_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('idempotency_keys_scope_key').on(t.scope, t.key),
    index('idempotency_keys_expires_idx').on(t.expiresAt),
  ],
);

/** Fixed-window counters. In the DB so limits hold across app instances. */
export const rateLimitBuckets = pgTable(
  'rate_limit_buckets',
  {
    bucketKey: text('bucket_key').primaryKey(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    counter: integer('counter').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('rate_limit_buckets_expires_idx').on(t.expiresAt)],
);

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id').references(() => events.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    severity: notificationSeverity('severity').notNull().default('INFO'),
    data: jsonb('data').notNull().default(sql`'{}'::jsonb`),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('notifications_user_time_idx').on(t.userId, t.createdAt),
    index('notifications_unread_idx')
      .on(t.userId)
      .where(sql`${t.readAt} is null`),
  ],
);

export const challenges = pgTable(
  'challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    rewardPoints: bigint('reward_points', { mode: 'number' }).notNull(),
    /** Score points awarded to the participant's team, if any. */
    rewardScorePoints: bigint('reward_score_points', { mode: 'number' }).notNull().default(0),
    maxCompletionsPerUser: integer('max_completions_per_user').notNull().default(1),
    status: challengeStatus('status').notNull().default('DRAFT'),
    startsAt: timestamp('starts_at', { withTimezone: true }),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('challenges_event_slug_key').on(t.eventId, t.slug),
    check('challenges_reward_non_negative', sql`${t.rewardPoints} >= 0 and ${t.rewardScorePoints} >= 0`),
    check('challenges_max_completions_positive', sql`${t.maxCompletionsPerUser} > 0`),
  ],
);

export const challengeCompletions = pgTable(
  'challenge_completions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    challengeId: uuid('challenge_id')
      .notNull()
      .references(() => challenges.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** 1-based; combined with the challenge's cap this is the DB-level guard
     *  against awarding a one-shot challenge twice under concurrency. */
    completionIndex: integer('completion_index').notNull().default(1),
    awardedPoints: bigint('awarded_points', { mode: 'number' }).notNull(),
    ledgerTransactionId: uuid('ledger_transaction_id').references(() => ledgerTransactions.id, {
      onDelete: 'restrict',
    }),
    verifiedBy: uuid('verified_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('challenge_completions_key').on(t.challengeId, t.userId, t.completionIndex),
    index('challenge_completions_user_idx').on(t.userId, t.createdAt),
  ],
);

export const achievements = pgTable(
  'achievements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    icon: text('icon'),
    criteria: jsonb('criteria').notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [uniqueIndex('achievements_event_key').on(t.eventId, t.key)],
);

export const userAchievements = pgTable(
  'user_achievements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    achievementId: uuid('achievement_id')
      .notNull()
      .references(() => achievements.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    unlockedAt: timestamp('unlocked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('user_achievements_key').on(t.achievementId, t.userId)],
);

export const rewards = pgTable(
  'rewards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    type: rewardType('type').notNull().default('PRODUCT'),
    costPoints: bigint('cost_points', { mode: 'number' }).notNull(),
    stock: integer('stock'),
    /** When set, redeeming this reward moves real inventory. */
    productId: uuid('product_id').references(() => products.id, { onDelete: 'set null' }),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('rewards_event_idx').on(t.eventId, t.isActive),
    check('rewards_cost_non_negative', sql`${t.costPoints} >= 0`),
  ],
);
