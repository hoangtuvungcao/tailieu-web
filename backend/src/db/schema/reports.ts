import { sql } from 'drizzle-orm';
import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { reportReasonEnum, reportStatusEnum, reportTargetEnum } from './enums.js';
import { users } from './identity.js';

/**
 * Content reports.
 *
 * The target is **polymorphic** — `(target_type, target_id)` rather than one FK
 * per possible target. That is the right call here specifically because a
 * report must be able to point at anything (a document, a post, a comment, a
 * user, a collection), and a report is an *allegation* rather than a reference:
 * the reported item may be deleted before the report is reviewed, and the
 * report must survive that. A foreign key with ON DELETE CASCADE would destroy
 * the evidence exactly when it matters.
 *
 * The cost is that nothing guarantees the target exists. That is handled where
 * the queue is rendered: an unresolvable target is shown as "content no longer
 * available" rather than crashing the moderator's screen.
 */
export const reports = pgTable(
  'reports',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    reporterUserId: uuid('reporter_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    targetType: reportTargetEnum('target_type').notNull(),
    targetId: uuid('target_id').notNull(),

    reason: reportReasonEnum('reason').notNull(),
    /** Free-text detail from the reporter. Optional; the reason may suffice. */
    details: text('details'),

    status: reportStatusEnum('status').notNull().default('pending'),

    resolvedByUserId: uuid('resolved_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolutionNote: text('resolution_note'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    /**
     * One OPEN report per (reporter, target).
     *
     * Partial on `status = 'pending'` rather than on `deleted_at`, because the
     * thing being deduplicated is an *unresolved* allegation. Once a report is
     * resolved, the same person reporting the same item again is a legitimate
     * signal — "it is still there" — and must not be silently swallowed by a
     * unique constraint.
     *
     * The same reporter filing twenty reports on one document is the most
     * common abuse of a report button, and this makes it impossible rather than
     * something a moderator has to clean up by hand.
     */
    uniqueIndex('reports_one_open_per_reporter_uq')
      .on(t.reporterUserId, t.targetType, t.targetId)
      .where(sql`status = 'pending' AND deleted_at IS NULL`),

    /** The moderation queue: oldest unresolved first. */
    index('reports_queue_idx')
      .on(t.createdAt)
      .where(sql`status IN ('pending', 'reviewing') AND deleted_at IS NULL`),

    /** "Everything reported about this item" — used on the moderation screen. */
    index('reports_target_idx').on(t.targetType, t.targetId, t.createdAt.desc()),

    /** A reporter's own history, so a serial reporter is visible. */
    index('reports_reporter_idx').on(t.reporterUserId, t.createdAt.desc()),
  ],
);

/**
 * Every moderation action taken, appended and never edited.
 *
 * Separate from `audit_logs` on purpose: `audit_logs` records *administrative*
 * actions (role changes, settings changes), while this records *content
 * decisions* — and the difference matters because a moderation action is
 * something the affected user may appeal, so it needs its own queryable history
 * including a reason the user can read.
 */
export const moderationActions = pgTable(
  'moderation_actions',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    moderatorUserId: uuid('moderator_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),

    targetType: reportTargetEnum('target_type').notNull(),
    targetId: uuid('target_id').notNull(),

    action: text('action').notNull(),
    /** Shown to the content's author when they are notified. */
    reason: text('reason'),

    /** The report this action resolved, when there was one. */
    reportId: uuid('report_id').references(() => reports.id, { onDelete: 'set null' }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('moderation_actions_target_idx').on(t.targetType, t.targetId, t.createdAt.desc()),
    index('moderation_actions_moderator_idx').on(t.moderatorUserId, t.createdAt.desc()),
  ],
);

export type ReportRow = typeof reports.$inferSelect;
export type ModerationActionRow = typeof moderationActions.$inferSelect;
