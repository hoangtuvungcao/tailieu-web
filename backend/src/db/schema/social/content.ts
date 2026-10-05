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
  doublePrecision,
} from 'drizzle-orm/pg-core';

import { citext } from '../custom-types.js';
import { documentVisibilityEnum } from '../enums.js';
import { documents } from '../documents.js';
import { users } from '../identity.js';
import { faculties } from '../taxonomy.js';
import { commentTargetEnum, moderationStateEnum, postKindEnum } from './enums.js';

/**
 * Posts and comments.
 *
 * Note what these do NOT do: `"X posted"` produces **zero notification rows**
 * for followers. Posts reach people through the following-feed query, which is
 * a join, not a fan-out write. One post by someone with 5,000 followers
 * inserting 5,000 rows is the classic way a social system falls over, and it
 * buys nothing that a feed query does not already provide.
 */

export const posts = pgTable(
  'posts',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    authorUserId: uuid('author_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    title: text('title'),
    body: text('body').notNull(),
    postKind: postKindEnum('post_kind').notNull().default('status'),

    visibility: documentVisibilityEnum('visibility').notNull().default('internal'),

    facultyId: uuid('faculty_id').references(() => faculties.id, { onDelete: 'set null' }),
    programId: uuid('program_id'),
    subjectId: uuid('subject_id'),

    linkUrl: text('link_url'),
    sharedDocumentId: uuid('shared_document_id').references(() => documents.id, {
      onDelete: 'set null',
    }),

    // --- Denormalised counters, maintained by `adjustCounter` in the same
    // transaction as the event. Never incremented from two code paths.
    likeCount: integer('like_count').notNull().default(0),
    commentCount: integer('comment_count').notNull().default(0),
    bookmarkCount: integer('bookmark_count').notNull().default(0),

    /**
     * Engagement-only score: `likes*3 + comments*5 + bookmarks*2`, with NO
     * `now()` term.
     *
     * That last part is the whole point. A gravity score that divides by age
     * cannot live in a column or an index, because the value would change
     * without anything being written — Postgres would need a full scan and sort
     * on every read. Keeping time out of the stored score makes it indexable;
     * recency is applied at read time against the small candidate set that the
     * index already narrowed down.
     */
    hotScore: doublePrecision('hot_score').notNull().default(0),

    moderationState: moderationStateEnum('moderation_state').notNull().default('visible'),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    pinnedAt: timestamp('pinned_at', { withTimezone: true }),

    /** Unaccented haystack, maintained by trigger like `documents.search_text`. */
    searchText: text('search_text').notNull().default(''),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    /**
     * Keyset pagination on `(created_at, id)`.
     *
     * `id` is the tiebreaker and is not decoration: two posts created in the
     * same millisecond would otherwise have an unstable order, and page 2 can
     * then repeat or skip a row that page 1 already showed.
     */
    index('posts_recent_idx')
      .on(t.createdAt.desc(), t.id.desc())
      .where(sql`deleted_at IS NULL AND moderation_state = 'visible'`),

    /** The "following" feed joins on this. */
    index('posts_author_recent_idx')
      .on(t.authorUserId, t.createdAt.desc(), t.id.desc())
      .where(sql`deleted_at IS NULL AND moderation_state = 'visible'`),

    index('posts_faculty_recent_idx')
      .on(t.facultyId, t.createdAt.desc(), t.id.desc())
      .where(sql`deleted_at IS NULL AND moderation_state = 'visible'`),

    /**
     * The "popular" fallback when Redis is unavailable.
     *
     * `hot_score` is engagement-only precisely so this index can exist — which
     * is why the decay term is applied in the query rather than stored.
     */
    index('posts_popular_idx')
      .on(t.hotScore.desc(), t.id.desc())
      .where(sql`deleted_at IS NULL AND moderation_state = 'visible'`),

    index('posts_moderation_idx')
      .on(t.createdAt)
      .where(sql`moderation_state <> 'visible' AND deleted_at IS NULL`),
  ],
);

/**
 * Comments on documents and posts.
 *
 * Polymorphic — `(target_type, target_id)` — because the alternative is a
 * `document_id` and a `post_id` column where exactly one is ever set, which
 * needs a CHECK constraint to stay honest and reads worse. Comment counts are
 * denormalised onto both targets, so integrity is protected by the counter
 * update rather than by a foreign key.
 */
export const comments = pgTable(
  'comments',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    targetType: commentTargetEnum('target_type').notNull(),
    targetId: uuid('target_id').notNull(),

    authorUserId: uuid('author_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    parentCommentId: uuid('parent_comment_id').references(
      (): import('drizzle-orm/pg-core').AnyPgColumn => comments.id,
      { onDelete: 'cascade' },
    ),
    /** The thread root. Equals `id` for a top-level comment. */
    rootCommentId: uuid('root_comment_id'),
    /** Capped at 3 by a CHECK constraint in post.sql. */
    depth: smallint('depth').notNull().default(0),

    body: text('body').notNull(),

    likeCount: integer('like_count').notNull().default(0),
    replyCount: integer('reply_count').notNull().default(0),

    moderationState: moderationStateEnum('moderation_state').notNull().default('visible'),
    editedAt: timestamp('edited_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    /**
     * Reading a thread: one target, root-first, then chronological.
     *
     * Fetching a whole thread in one indexed scan and grouping in memory beats
     * a recursive query here, because the depth cap is 3 — the tree is shallow
     * enough that a flat list is simpler and faster.
     */
    index('comments_thread_idx')
      .on(t.targetType, t.targetId, t.rootCommentId, t.createdAt, t.id)
      .where(sql`deleted_at IS NULL AND moderation_state = 'visible'`),

    index('comments_replies_idx')
      .on(t.parentCommentId, t.createdAt)
      .where(sql`deleted_at IS NULL`),

    index('comments_author_idx')
      .on(t.authorUserId, t.createdAt.desc())
      .where(sql`deleted_at IS NULL`),
  ],
);

/**
 * Post tags, mirroring `document_tags`.
 *
 * A separate table from document tags rather than one polymorphic tag link,
 * because tag counts and the tag cloud are per-content-type and mixing them
 * makes "most used tags on documents" require a join through a discriminator.
 */
export const postTags = pgTable(
  'post_tags',
  {
    postId: uuid('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('post_tags_uq').on(t.postId, t.tagId),
    index('post_tags_tag_idx').on(t.tagId),
  ],
);

/** Post links, for a post that carries more than one. */
export const postMedia = pgTable(
  'post_media',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    postId: uuid('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    mediaKind: citext('media_kind').notNull().default('link'),
    position: smallint('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('post_media_post_idx').on(t.postId, t.position)],
);
