import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { citext } from '../custom-types.js';
import { users } from '../identity.js';
import {
  leaderboardPeriodEnum,
  leaderboardScopeEnum,
  notificationKindEnum,
  reputationReasonEnum,
  socialTargetEnum,
} from './enums.js';

// =============================================================================
// Social graph
// =============================================================================

/**
 * Follows.
 *
 * `follower -> followee`, directional. The two indexes are not redundant: one
 * serves "who do I follow" (building the feed) and the other "who follows me"
 * (the follower list), and those are different scans.
 */
export const follows = pgTable(
  'follows',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    followerUserId: uuid('follower_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    followeeUserId: uuid('followee_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('follows_uq')
      .on(t.followerUserId, t.followeeUserId)
      .where(sql`deleted_at IS NULL`),
    index('follows_following_idx')
      .on(t.followerUserId, t.followeeUserId)
      .where(sql`deleted_at IS NULL`),
    index('follows_followers_idx')
      .on(t.followeeUserId, t.createdAt.desc())
      .where(sql`deleted_at IS NULL`),
  ],
);

/**
 * Scope subscriptions — the honest basis for "For You".
 *
 * Following a *faculty* or a *subject* is what makes a personalised feed
 * possible without a recommender: the candidate set is "what the people and
 * scopes you chose have published", ranked by engagement and recency.
 */
export const subscriptions = pgTable(
  'subscriptions',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    targetType: socialTargetEnum('target_type').notNull(),
    targetId: uuid('target_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('subscriptions_uq')
      .on(t.userId, t.targetType, t.targetId)
      .where(sql`deleted_at IS NULL`),
    index('subscriptions_user_idx')
      .on(t.userId, t.targetType)
      .where(sql`deleted_at IS NULL`),
  ],
);

// =============================================================================
// Notifications
// =============================================================================

/**
 * Notifications, built for a polling client.
 *
 * The client polls the unread count every 30–60 seconds, so that count can
 * never be `count(*)` — it would scan this table on a timer, forever. It lives
 * as a denormalised column on `users` instead (see `users.unreadNotificationCount`
 * added in the migration), making the poll a primary-key lookup.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    recipientUserId: uuid('recipient_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Null for a system notification. */
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),

    kind: notificationKindEnum('kind').notNull(),
    targetType: socialTargetEnum('target_type'),
    targetId: uuid('target_id'),

    /**
     * Actor name and avatar only — never a snapshot of the target's title.
     *
     * A denormalised document title would leak content to someone whose access
     * was revoked after the notification was written. The target is re-read at
     * display time and passes the same visibility check as any other read.
     */
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),

    /**
     * Collapses a mass event into one row.
     *
     * A thousand likes on one post is one notification ("A and 999 others"),
     * not a thousand. The partial unique below enforces it: one *unread* row
     * per (recipient, group_key), which re-arms after the user reads it.
     */
    groupKey: text('group_key').notNull(),
    aggregationCount: integer('aggregation_count').notNull().default(1),

    seenAt: timestamp('seen_at', { withTimezone: true }),
    readAt: timestamp('read_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('notifications_list_idx')
      .on(t.recipientUserId, t.createdAt.desc(), t.id.desc())
      .where(sql`deleted_at IS NULL`),

    uniqueIndex('notifications_group_uq')
      .on(t.recipientUserId, t.groupKey)
      .where(sql`read_at IS NULL AND deleted_at IS NULL`),

    /**
     * Kept for reconciliation and the self-heal sweep, NOT for the badge.
     *
     * The badge reads the denormalised counter; this index exists so a drift
     * between the two can be found and repaired.
     */
    index('notifications_unread_idx')
      .on(t.recipientUserId)
      .where(sql`read_at IS NULL AND deleted_at IS NULL`),
  ],
);

// =============================================================================
// Reputation
// =============================================================================

/**
 * Append-only reputation ledger.
 *
 * Note the absence of `deleted_at`: this is immutable, so a plain
 * `UNIQUE(dedupe_key)` is correct and is the one place the project's
 * partial-unique convention deliberately does not apply — a partial index on
 * `deleted_at IS NULL` would be a partial index on something that is never set.
 */
export const reputationEvents = pgTable(
  'reputation_events',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    delta: integer('delta').notNull(),
    reason: reputationReasonEnum('reason').notNull(),
    sourceType: socialTargetEnum('source_type'),
    sourceId: uuid('source_id'),
    /** Who caused it. The denominator for anti-abuse weighting. */
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),

    /**
     * Idempotency. `'like:comment:<id>:v1'` — retrying the same award is a
     * no-op rather than a double credit, and the `:v1` suffix lets a rules
     * change re-award deliberately rather than accidentally.
     */
    dedupeKey: text('dedupe_key'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('reputation_events_dedupe_uq')
      .on(t.dedupeKey)
      .where(sql`dedupe_key IS NOT NULL`),
    index('reputation_events_user_idx').on(t.userId, t.createdAt.desc()),
    index('reputation_events_time_idx').on(t.createdAt),
  ],
);

export const badges = pgTable(
  'badges',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    code: citext('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    icon: text('icon'),
    /** Cosmetic tier. Deliberately does NOT affect reputation — see below. */
    tier: smallint('tier').notNull().default(1),
    category: text('category').notNull().default('general'),

    /**
     * Award criteria, evaluated lazily when a reputation event is written.
     *
     * `{ "metric": "reputation", "threshold": 100 }` — O(1) to check, so no
     * cron job is needed for the common case.
     */
    criteria: jsonb('criteria').notNull().default(sql`'{}'::jsonb`),

    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('badges_code_uq')
      .on(t.code)
      .where(sql`deleted_at IS NULL`),
  ],
);

export const userBadges = pgTable(
  'user_badges',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    badgeId: uuid('badge_id')
      .notNull()
      .references(() => badges.id, { onDelete: 'cascade' }),
    awardedAt: timestamp('awarded_at', { withTimezone: true }).notNull().defaultNow(),
    awardReason: text('award_reason'),
    /**
     * Revocation marker. The partial unique is on THIS column rather than
     * `deleted_at`, because a badge is revoked, not deleted — and a revoked
     * badge must not block re-awarding.
     */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('user_badges_uq')
      .on(t.userId, t.badgeId)
      .where(sql`revoked_at IS NULL`),
    index('user_badges_user_idx').on(t.userId),
  ],
);

// =============================================================================
// Leaderboards
// =============================================================================

/**
 * Incremental running totals.
 *
 * The alternative — `SELECT user_id, sum(delta) FROM reputation_events WHERE
 * created_at >= :start GROUP BY user_id ORDER BY 2 DESC` — is O(events in the
 * period) plus an aggregate plus a sort, and joining it to `users` for a
 * faculty filter makes it worse. That query is fine today and falls over
 * exactly when the platform succeeds.
 *
 * This table trades it for one UPSERT per reputation event into a bounded
 * number of rows (university + the user's faculty + the user's program), and
 * turns the leaderboard read into a top-N index scan.
 */
export const leaderboardRunningTotals = pgTable(
  'leaderboard_running_totals',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),

    periodType: leaderboardPeriodEnum('period_type').notNull(),
    /** `'2026-10'`, or the semester's id. No new time concept invented. */
    periodKey: text('period_key').notNull(),
    scopeType: leaderboardScopeEnum('scope_type').notNull(),
    /** Null for the university-wide row. */
    scopeId: uuid('scope_id'),

    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    score: numeric('score', { precision: 12, scale: 2 }).notNull().default('0'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /**
     * A unique CONSTRAINT with `NULLS NOT DISTINCT` — NOT a primary key over
     * these five columns.
     *
     * A primary key column is implicitly NOT NULL in Postgres, so including
     * `scope_id` in one makes the university-wide row — the row whose
     * `scope_id IS NULL`, which is the main reason this table exists —
     * impossible to insert at all. The declaration read as though null were
     * allowed and the database disagreed, and nothing caught it because no code
     * had ever written a row: the failure is a not-null violation on the first
     * reputation event rather than anything a schema review surfaces.
     *
     * `NULLS NOT DISTINCT` is still required, for the same reason the snapshot
     * table below needs it: without it `scope_id NULL` would be considered
     * distinct from itself, and every UPSERT would insert another row instead
     * of accumulating — silently counting one member once per event.
     */
    unique('leaderboard_running_totals_uq')
      .on(t.periodType, t.periodKey, t.scopeType, t.scopeId, t.userId)
      .nullsNotDistinct(),
    index('leaderboard_running_totals_top_idx').on(
      t.periodType,
      t.periodKey,
      t.scopeType,
      t.scopeId,
      t.score.desc(),
      t.userId,
    ),
  ],
);

/** Finalised period snapshots, so historical ranks never drift. */
export const leaderboardSnapshots = pgTable(
  'leaderboard_snapshots',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    scopeType: leaderboardScopeEnum('scope_type').notNull(),
    scopeId: uuid('scope_id'),
    periodType: leaderboardPeriodEnum('period_type').notNull(),
    periodKey: text('period_key').notNull(),
    metric: text('metric').notNull().default('reputation'),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
    isFinal: boolean('is_final').notNull().default(false),
  },
  (t) => [
    // A unique CONSTRAINT, not a partial index: `scope_id` is NULL for the
    // university-wide snapshot, and without NULLS NOT DISTINCT two such rows
    // would be considered distinct and every recompute would insert another.
    unique('leaderboard_snapshots_uq')
      .on(t.scopeType, t.scopeId, t.periodType, t.periodKey, t.metric)
      .nullsNotDistinct(),
  ],
);

export const leaderboardEntries = pgTable(
  'leaderboard_entries',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    snapshotId: uuid('snapshot_id')
      .notNull()
      .references(() => leaderboardSnapshots.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    rank: integer('rank').notNull(),
    score: numeric('score', { precision: 12, scale: 2 }).notNull(),
    breakdown: jsonb('breakdown').notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [
    uniqueIndex('leaderboard_entries_user_uq').on(t.snapshotId, t.userId),
    uniqueIndex('leaderboard_entries_rank_uq').on(t.snapshotId, t.rank),
  ],
);
