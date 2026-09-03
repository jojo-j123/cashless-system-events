import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { eventStatus, userStatus } from './enums';

export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    timezone: text('timezone').notNull().default('UTC'),
    status: eventStatus('status').notNull().default('DRAFT'),
    startsAt: timestamp('starts_at', { withTimezone: true }),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('events_slug_key').on(t.slug), index('events_status_idx').on(t.status)],
);

/**
 * One settings row per event. Values are validated by `lib/settings/schema.ts`
 * before they are written, so the jsonb blob is always a known shape.
 */
export const eventSettings = pgTable('event_settings', {
  eventId: uuid('event_id')
    .primaryKey()
    .references(() => events.id, { onDelete: 'cascade' }),
  settings: jsonb('settings').notNull().default(sql`'{}'::jsonb`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by'),
});

/**
 * Users are global, not per-event: one person keeps one login across events.
 * Their money is per-event (see `accounts`).
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email'),
    phone: text('phone'),
    displayName: text('display_name').notNull(),
    avatarUrl: text('avatar_url'),
    passwordHash: text('password_hash'),
    /** Separate from the password: used to confirm high-value staff actions. */
    pinHash: text('pin_hash'),
    /** HMAC key for this user's rotating QR fallback credential. */
    qrSecret: text('qr_secret').notNull(),
    isSuperAdmin: boolean('is_super_admin').notNull().default(false),
    status: userStatus('status').notNull().default('ACTIVE'),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    // Case-insensitive uniqueness, and only across live rows so a soft-deleted
    // account never blocks re-registration of the same address.
    uniqueIndex('users_email_key')
      .on(sql`lower(${t.email})`)
      .where(sql`${t.deletedAt} is null and ${t.email} is not null`),
    uniqueIndex('users_phone_key')
      .on(t.phone)
      .where(sql`${t.deletedAt} is null and ${t.phone} is not null`),
    index('users_display_name_idx').on(t.displayName),
  ],
);

export const userProfiles = pgTable('user_profiles', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  externalRef: text('external_ref'),
  dietaryNotes: text('dietary_notes'),
  emergencyContact: text('emergency_contact'),
  metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const roles = pgTable(
  'roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    isSystem: boolean('is_system').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('roles_key_key').on(t.key)],
);

export const permissions = pgTable(
  'permissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: text('key').notNull(),
    description: text('description').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('permissions_key_key').on(t.key)],
);

export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permissionId: uuid('permission_id')
      .notNull()
      .references(() => permissions.id, { onDelete: 'cascade' }),
  },
  (t) => [
    unique('role_permissions_pk').on(t.roleId, t.permissionId),
    index('role_permissions_role_idx').on(t.roleId),
  ],
);

/**
 * A grant of a role, optionally narrowed to one event and/or one store.
 * A cashier at Store A holds no authority at Store B.
 */
export const userRoles = pgTable(
  'user_roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'restrict' }),
    eventId: uuid('event_id').references(() => events.id, { onDelete: 'cascade' }),
    storeId: uuid('store_id'),
    grantedBy: uuid('granted_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // COALESCE keeps NULL scopes from defeating uniqueness.
    uniqueIndex('user_roles_scope_key').on(
      t.userId,
      t.roleId,
      sql`coalesce(${t.eventId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      sql`coalesce(${t.storeId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
    ),
    index('user_roles_user_idx').on(t.userId, t.eventId),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 of the opaque token. The raw token exists only in the cookie. */
    tokenHash: text('token_hash').notNull(),
    csrfTokenHash: text('csrf_token_hash').notNull(),
    userAgent: text('user_agent'),
    ipAddress: text('ip_address'),
    terminalId: uuid('terminal_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
  },
  (t) => [
    uniqueIndex('sessions_token_hash_key').on(t.tokenHash),
    index('sessions_user_idx').on(t.userId),
    index('sessions_expires_idx').on(t.expiresAt),
  ],
);

/** Membership of a person in an event, independent of team assignment. */
export const eventParticipants = pgTable(
  'event_participants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    participantRef: text('participant_ref').notNull(),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('event_participants_key').on(t.eventId, t.userId),
    uniqueIndex('event_participants_ref_key').on(t.eventId, t.participantRef),
  ],
);
