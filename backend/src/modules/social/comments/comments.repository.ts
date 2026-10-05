import { and, asc, count, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';

import { db, type Database } from '../../../db/client.js';
import { commentLikes, comments, users } from '../../../db/schema/index.js';
import { toOffset, type PaginationInput } from '../../../lib/pagination.js';

export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
export type Executor = Tx | typeof db;

/**
 * Comment data access.
 *
 * Comments are polymorphic — they hang off a document OR a post — so the
 * repository never decides visibility by itself. The service resolves the
 * target first and refuses the request outright if the viewer cannot see it,
 * which means a comment on a private document is unreachable rather than
 * merely filtered out.
 */

const commentColumns = {
  id: comments.id,
  targetType: comments.targetType,
  targetId: comments.targetId,
  authorUserId: comments.authorUserId,
  authorName: users.displayName,
  authorAvatar: users.avatarUrl,
  parentCommentId: comments.parentCommentId,
  rootCommentId: comments.rootCommentId,
  depth: comments.depth,
  body: comments.body,
  likeCount: comments.likeCount,
  replyCount: comments.replyCount,
  moderationState: comments.moderationState,
  deletedAt: comments.deletedAt,
  editedAt: comments.editedAt,
  createdAt: comments.createdAt,
};

export interface CommentRow {
  id: string;
  targetType: 'document' | 'post';
  targetId: string;
  authorUserId: string;
  authorName: string | null;
  authorAvatar: string | null;
  parentCommentId: string | null;
  rootCommentId: string | null;
  depth: number;
  body: string;
  likeCount: number;
  replyCount: number;
  moderationState: 'visible' | 'hidden' | 'removed';
  deletedAt: Date | string | null;
  editedAt: Date | string | null;
  createdAt: Date | string;
}

/**
 * The row is gone from the reader's point of view, but its slot remains.
 *
 * Either an author deleted it or a moderator took it down. The two are
 * deliberately collapsed: telling a reader *which* happened would announce that
 * a moderator acted, and the body is withheld in both cases anyway.
 */
export function isTombstone(row: CommentRow): boolean {
  return row.deletedAt !== null || row.moderationState !== 'visible';
}

function normalise(row: Record<string, unknown>): CommentRow {
  return {
    ...row,
    depth: Number(row.depth ?? 0),
    likeCount: Number(row.likeCount ?? 0),
    replyCount: Number(row.replyCount ?? 0),
  } as CommentRow;
}

/**
 * Fetch an entire thread for one target in a single indexed scan.
 *
 * Not a recursive query. The depth cap is 3, so the tree is shallow enough that
 * one flat read ordered by `(root, created_at)` and grouped in memory is both
 * simpler and faster than a recursive CTE — and it paginates naturally by root
 * comment rather than by individual reply.
 *
 * Removed comments are returned, and that is the whole point. Filtering them
 * out reads as harmless tidying and is not: the grouping pass in the service
 * buckets replies under their root, so a root that is missing from the result
 * takes its entire subtree with it. Delete one top-level comment and every live
 * reply beneath it disappears — while the post's `comment_count`, which is
 * deliberately never decremented, still advertises the full total. The reader
 * sees "3 bình luận" above an empty thread.
 *
 * So a removed comment keeps its slot and is turned into a tombstone by the
 * service. Its body never leaves the server — `toDto` withholds it — but its
 * position in the tree is what keeps other people's replies reachable.
 */
export async function listThread(
  targetType: 'document' | 'post',
  targetId: string,
  pagination: PaginationInput,
  executor: Executor = db,
) {
  // Top-level comments first, then their replies. Pagination is over roots, so
  // a thread with 200 replies does not push other threads off page 1.
  const [rows, [totalRow]] = await Promise.all([
    executor
      .select(commentColumns)
      .from(comments)
      .innerJoin(users, eq(users.id, comments.authorUserId))
      .where(and(eq(comments.targetType, targetType), eq(comments.targetId, targetId)))
      .orderBy(asc(comments.rootCommentId), asc(comments.createdAt), asc(comments.id))
      .limit(pagination.limit * 20)
      .offset(toOffset(pagination)),
    // Counts roots the same way the list renders them — tombstones included —
    // so the pager agrees with the thread rather than with a filtered subset.
    executor
      .select({ value: count() })
      .from(comments)
      .where(
        and(
          eq(comments.targetType, targetType),
          eq(comments.targetId, targetId),
          isNull(comments.parentCommentId),
        ),
      ),
  ]);

  return {
    items: rows.map((r) => normalise(r as Record<string, unknown>)),
    total: Number(totalRow?.value ?? 0),
  };
}

export async function findCommentById(id: string, executor: Executor = db): Promise<CommentRow | null> {
  const rows = await executor
    .select(commentColumns)
    .from(comments)
    .innerJoin(users, eq(users.id, comments.authorUserId))
    .where(and(eq(comments.id, id), isNull(comments.deletedAt)))
    .limit(1);

  const row = rows[0];
  return row ? normalise(row as Record<string, unknown>) : null;
}

export async function insertComment(
  executor: Executor,
  values: {
    targetType: 'document' | 'post';
    targetId: string;
    authorUserId: string;
    parentCommentId: string | null;
    rootCommentId: string | null;
    depth: number;
    body: string;
  },
): Promise<{ id: string }> {
  const [row] = await executor.insert(comments).values(values).returning({ id: comments.id });
  return { id: row!.id };
}

/** A reply's root is its parent's root; a top-level comment is its own root. */
export async function setRoot(executor: Executor, id: string): Promise<void> {
  await executor.execute(sql`UPDATE comments SET root_comment_id = ${id} WHERE id = ${id}`);
}

export async function updateComment(
  executor: Executor,
  id: string,
  body: string,
): Promise<void> {
  await executor
    .update(comments)
    .set({ body, editedAt: new Date(), updatedAt: new Date() })
    .where(eq(comments.id, id));
}

export async function softDeleteComment(executor: Executor, id: string): Promise<void> {
  await executor
    .update(comments)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(comments.id, id));
}

/** Which of these comments the viewer has liked — one query, not one per row. */
export async function findLikedCommentIds(
  commentIds: string[],
  userId: string | null,
  executor: Executor = db,
): Promise<Set<string>> {
  if (!userId || commentIds.length === 0) return new Set();

  const rows = await executor
    .select({ commentId: commentLikes.commentId })
    .from(commentLikes)
    .where(
      and(
        eq(commentLikes.userId, userId),
        inArray(commentLikes.commentId, commentIds),
        isNull(commentLikes.deletedAt),
      ),
    );

  return new Set(rows.map((r) => r.commentId));
}

/** Recent comments by one author, for a profile page. */
export async function listByAuthor(
  authorUserId: string,
  pagination: PaginationInput,
  executor: Executor = db,
) {
  // A profile list is flat, so a removed comment has no replies depending on
  // its position and simply drops out. Contrast `listThread`, which must keep
  // removed rows to hold the tree together.
  const visible = and(isNull(comments.deletedAt), eq(comments.moderationState, 'visible'))!;

  const [rows, [totalRow]] = await Promise.all([
    executor
      .select(commentColumns)
      .from(comments)
      .innerJoin(users, eq(users.id, comments.authorUserId))
      .where(and(visible, eq(comments.authorUserId, authorUserId)))
      .orderBy(desc(comments.createdAt))
      .limit(pagination.limit)
      .offset(toOffset(pagination)),
    executor
      .select({ value: count() })
      .from(comments)
      .where(and(visible, eq(comments.authorUserId, authorUserId))),
  ]);

  return {
    items: rows.map((r) => normalise(r as Record<string, unknown>)),
    total: Number(totalRow?.value ?? 0),
  };
}
