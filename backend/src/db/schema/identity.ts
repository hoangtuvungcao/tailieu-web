import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

import { bytea, citext, inet } from './custom-types.js';
import { authProviderEnum, authTokenTypeEnum, userStatusEnum, verificationStatusEnum } from './enums.js';
import { faculties, programs } from './taxonomy.js';

/**
 * Identity, credentials and sessions.
 *
 * Load-bearing decisions in this file:
 *
 * 1. `users` has NO soft-delete-releases-email behaviour. The email unique
 *    index is UNCONDITIONAL. If a deleted account released its address, an
 *    attacker could re-register a departed student's email and inherit their
 *    authorship, reputation and documents. Erasure anonymises the address
 *    instead of freeing it.
 *
 * 2. Passwords live in `auth_identities`, not `users`. A user may have a
 *    password identity, a Google identity, or both — adding an OAuth provider
 *    later is an INSERT, not a schema migration.
 *
 * 3. `users.token_version` is the global kill switch. Bumping it invalidates
 *    every outstanding access token for that user immediately, which is what
 *    makes "logout all devices" and refresh-token-reuse response effective
 *    rather than merely eventual.
 */

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    email: citext('email').notNull(),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    username: citext('username'),
    displayName: text('display_name').notNull(),
    fullName: text('full_name'),
    bio: text('bio'),
    avatarUrl: text('avatar_url'),
    coverUrl: text('cover_url'),
    status: userStatusEnum('status').notNull().default('active'),

    /** Bump to invalidate every access token issued before this moment. */
    tokenVersion: integer('token_version').notNull().default(0),

    primaryFacultyId: uuid('primary_faculty_id').references(() => faculties.id, {
      onDelete: 'set null',
    }),
    primaryProgramId: uuid('primary_program_id').references(() => programs.id, {
      onDelete: 'set null',
    }),
    studentCode: text('student_code'),
    enrollmentYear: smallint('enrollment_year'),

    /**
     * Denormalised unread-notification badge.
     *
     * A column, not `count(*)`. The client polls this every 30-60 seconds, and
     * counting rows on a timer is a scan of a table that only grows. As a
     * column it is a primary-key lookup — O(1) regardless of how many
     * notifications exist. Maintained in the same transaction as every insert
     * and mark-read, with a reconcile query available to self-heal drift.
     */
    unreadNotificationCount: integer('unread_notification_count').notNull().default(0),

    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    /** Set only by an erasure request; the email is anonymised at the same time. */
    anonymizedAt: timestamp('anonymized_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // UNCONDITIONAL on purpose — see the note at the top of this file.
    uniqueIndex('users_email_uq').on(t.email),
    uniqueIndex('users_username_uq')
      .on(t.username)
      .where(sql`username IS NOT NULL AND anonymized_at IS NULL`),
    index('users_faculty_idx')
      .on(t.primaryFacultyId)
      .where(sql`anonymized_at IS NULL`),
    index('users_status_idx').on(t.status),
    index('users_display_name_trgm_idx').using(
      'gin',
      sql`immutable_unaccent(display_name) gin_trgm_ops`,
    ),
  ],
);

export const authIdentities = pgTable(
  'auth_identities',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: authProviderEnum('provider').notNull(),
    /** password -> lowercased email; google -> the OAuth `sub` claim. */
    providerUid: text('provider_uid').notNull(),
    /** Argon2id encoded string. NULL for providers without a local password. */
    passwordHash: text('password_hash'),
    /** Set when the password is confirmed compromised and must be changed. */
    passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('auth_identities_provider_uid_uq').on(t.provider, t.providerUid),
    index('auth_identities_user_idx').on(t.userId),
  ],
);

/**
 * One row per login "family" — a device that logged in and keeps refreshing.
 * Rotation issues new refresh tokens within the same session; reuse detection
 * revokes the whole session at once.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Groups all descendant tokens. Equals `id` at creation. */
    familyId: uuid('family_id').notNull(),
    userAgent: text('user_agent'),
    ip: inet('ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
    /** Absolute lifetime. Rotation never extends this. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /** 'logout' | 'rotated_reuse' | 'logout_all' | 'password_change' | 'admin' */
    revokedReason: text('revoked_reason'),
    /** Last CSRF token issued for this session (double-submit pattern). */
    csrfTokenHash: bytea('csrf_token_hash'),
  },
  (t) => [
    index('sessions_active_idx')
      .on(t.userId, t.lastUsedAt)
      .where(sql`revoked_at IS NULL`),
    index('sessions_family_idx').on(t.familyId),
    index('sessions_expiry_idx').on(t.expiresAt),
  ],
);

/**
 * Every rotation writes a row and marks its parent rotated. Presenting an
 * already-rotated token is the theft signal that triggers family revocation.
 */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    /** sha256(raw). The raw token is never persisted. */
    tokenHash: bytea('token_hash').notNull(),
    // Self-referencing FK needs an explicit return type: without `AnyPgColumn`
    // TypeScript cannot infer the type of `refreshTokens` from an initializer
    // that refers to `refreshTokens` itself.
    parentId: uuid('parent_id').references((): AnyPgColumn => refreshTokens.id, {
      onDelete: 'set null',
    }),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Set when this token is exchanged for a successor. */
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('refresh_tokens_hash_uq').on(t.tokenHash),
    index('refresh_tokens_session_idx').on(t.sessionId),
    index('refresh_tokens_expiry_idx').on(t.expiresAt),
  ],
);

/** Email verification and password reset. One row per issued token. */
export const authTokens = pgTable(
  'auth_tokens',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: authTokenTypeEnum('type').notNull(),
    tokenHash: bytea('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('auth_tokens_hash_uq').on(t.tokenHash),
    index('auth_tokens_user_type_idx').on(t.userId, t.type),
  ],
);

/**
 * Student/lecturer identity verification. The `verified_student` badge is
 * derived from an approved row here — a user can never grant it to themselves.
 */
export const studentVerifications = pgTable(
  'student_verifications',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    facultyId: uuid('faculty_id').references(() => faculties.id, { onDelete: 'set null' }),
    programId: uuid('program_id').references(() => programs.id, { onDelete: 'set null' }),
    studentCode: text('student_code'),
    status: verificationStatusEnum('status').notNull().default('pending'),
    reviewedBy: uuid('reviewed_by').references(() => users.id, { onDelete: 'set null' }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // At most one *approved* verification per user.
    uniqueIndex('student_verifications_approved_uq')
      .on(t.userId)
      .where(sql`status = 'approved'`),
    index('student_verifications_pending_idx')
      .on(t.createdAt)
      .where(sql`status = 'pending'`),
  ],
);
