import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { documentVisibilityEnum } from '../enums.js';
import { documents } from '../documents.js';
import { users } from '../identity.js';
import { comments, posts } from './content.js';
import { reactionEnum, socialTargetEnum } from './enums.js';

/**
 * Likes.
 *
 * THREE tables, not one polymorphic `(target_type, target_id)` table. The
 * polymorphic version looks tidier and is the wrong call here:
 *
 *   - No foreign key is possible, so a hard-deleted post leaves likes pointing
 *     at nothing, and the counter it fed drifts permanently.
 *   - The three target types have wildly different densities. One index over
 *     all of them has worse cache locality for the dominant rows and planner
 *     statistics skewed across types.
 *   - Likes are the hottest write in the system and the most counter-sensitive.
 *     Per-table indexes match the actual access pattern exactly.
 *
 * Polymorphism IS used for notifications, bookmarks and subscriptions — places
 * where cross-type listing is the entire point and referential integrity is
 * re-checked at hydration instead.
 *
 * All three share a shape, and all three use **restore-on-relike**: liking
 * again clears `deleted_at` rather than inserting a second row, so the count
 * cannot double and the partial unique stays meaningful.
 */

const likeColumns = {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  reaction: reactionEnum('reaction').notNull().default('like'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
};

export const documentLikes = pgTable(
  'document_likes',
  {
    ...likeColumns,
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
  },
  (t) => [
    uniqueIndex('document_likes_uq').on(t.userId, t.documentId).where(sql`deleted_at IS NULL`),
    index('document_likes_target_idx')
      .on(t.documentId, t.createdAt.desc())
      .where(sql`deleted_at IS NULL`),
    index('document_likes_user_idx')
      .on(t.userId, t.createdAt.desc())
      .where(sql`deleted_at IS NULL`),
  ],
);

export const postLikes = pgTable(
  'post_likes',
  {
    ...likeColumns,
    postId: uuid('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
  },
  (t) => [
    uniqueIndex('post_likes_uq').on(t.userId, t.postId).where(sql`deleted_at IS NULL`),
    index('post_likes_target_idx')
      .on(t.postId, t.createdAt.desc())
      .where(sql`deleted_at IS NULL`),
    index('post_likes_user_idx')
      .on(t.userId, t.createdAt.desc())
      .where(sql`deleted_at IS NULL`),
  ],
);

export const commentLikes = pgTable(
  'comment_likes',
  {
    ...likeColumns,
    commentId: uuid('comment_id')
      .notNull()
      .references(() => comments.id, { onDelete: 'cascade' }),
  },
  (t) => [
    uniqueIndex('comment_likes_uq').on(t.userId, t.commentId).where(sql`deleted_at IS NULL`),
    index('comment_likes_target_idx')
      .on(t.commentId, t.createdAt.desc())
      .where(sql`deleted_at IS NULL`),
  ],
);

// =============================================================================
// Collections
// =============================================================================

export const collections = pgTable(
  'collections',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    title: text('title').notNull(),
    description: text('description'),
    visibility: documentVisibilityEnum('visibility').notNull().default('private'),

    coverDocumentId: uuid('cover_document_id').references(() => documents.id, {
      onDelete: 'set null',
    }),

    itemCount: integer('item_count').notNull().default(0),
    followerCount: integer('follower_count').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    /**
     * One collection per title per owner, case-insensitively.
     *
     * `lower(immutable_unaccent(title))` rather than the raw column, so
     * "Ôn thi" and "ôn thi" are the same collection. Two collections differing
     * only in capitalisation is never what the user meant.
     *
     * The `immutable_unaccent` call is not decoration. This cluster runs with
     * LC_COLLATE=C, where `lower()` folds ASCII only — `lower('Ôn thi')` returns
     * 'Ôn thi' unchanged, so a plain `lower(title)` index would happily accept
     * both spellings. See the matching note in `sql/post.sql`, which creates
     * the index this declaration mirrors.
     */
    uniqueIndex('collections_owner_title_uq')
      .on(t.ownerUserId, sql`lower(immutable_unaccent(title))`)
      .where(sql`deleted_at IS NULL`),
    index('collections_owner_idx')
      .on(t.ownerUserId, t.createdAt.desc())
      .where(sql`deleted_at IS NULL`),
    index('collections_public_idx')
      .on(t.createdAt.desc(), t.id.desc())
      .where(sql`deleted_at IS NULL AND visibility = 'public'`),
  ],
);

export const collectionItems = pgTable(
  'collection_items',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    targetType: socialTargetEnum('target_type').notNull(),
    targetId: uuid('target_id').notNull(),
    addedByUserId: uuid('added_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    position: integer('position').notNull().default(0),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('collection_items_uq')
      .on(t.collectionId, t.targetType, t.targetId)
      .where(sql`deleted_at IS NULL`),
    index('collection_items_order_idx')
      .on(t.collectionId, t.position)
      .where(sql`deleted_at IS NULL`),
  ],
);

// =============================================================================
// Bookmarks
// =============================================================================

export const bookmarks = pgTable(
  'bookmarks',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    targetType: socialTargetEnum('target_type').notNull(),
    targetId: uuid('target_id').notNull(),
    /** Optional folder, for the "bookmark folders" requirement. */
    folder: text('folder'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('bookmarks_uq')
      .on(t.userId, t.targetType, t.targetId)
      .where(sql`deleted_at IS NULL`),
    index('bookmarks_user_idx')
      .on(t.userId, t.createdAt.desc())
      .where(sql`deleted_at IS NULL`),
    index('bookmarks_folder_idx')
      .on(t.userId, t.folder)
      .where(sql`deleted_at IS NULL AND folder IS NOT NULL`),
  ],
);

/** Saved searches — a bookmark over a query rather than over content. */
export const savedSearches = pgTable(
  'saved_searches',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    queryString: text('query_string').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('saved_searches_uq')
      .on(t.userId, sql`lower(immutable_unaccent(label))`)
      .where(sql`deleted_at IS NULL`),
  ],
);
