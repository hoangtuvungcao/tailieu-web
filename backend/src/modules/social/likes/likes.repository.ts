import { and, eq, isNull, sql } from 'drizzle-orm';

import { commentLikes, documentLikes, postLikes } from '../../../db/schema/index.js';
import type { Executor, Tx } from '../../documents/documents.repository.js';

/**
 * Likes across three tables.
 *
 * Separate tables rather than one polymorphic `(target_type, target_id)` — see
 * `db/schema/social/engagement.ts` for the reasoning. The cost is the dispatch
 * below, and it buys real foreign keys plus an index matching each access
 * pattern exactly.
 *
 * The dispatch is written as explicit branches rather than a table lookup.
 * TypeScript cannot index a union of tables by a union of column names, because
 * the three tables genuinely have different columns — and the same shape failed
 * at runtime in `adjustCounter`, where a dynamically-built statement produced
 * malformed SQL. Explicit branches are checked by the compiler AND render
 * correctly.
 *
 * All three use **restore-on-relike**: liking something again clears
 * `deleted_at` rather than inserting a second row. Without that, a
 * like/unlike/like cycle accumulates rows and the incremented counter drifts
 * permanently.
 */

export type LikeTarget = 'document' | 'post' | 'comment';

/** True when the viewer currently likes this thing. */
export async function isLiked(
  executor: Executor,
  target: LikeTarget,
  targetId: string,
  userId: string,
): Promise<boolean> {
  switch (target) {
    case 'document': {
      const rows = await executor
        .select({ id: documentLikes.id })
        .from(documentLikes)
        .where(
          and(
            eq(documentLikes.userId, userId),
            eq(documentLikes.documentId, targetId),
            isNull(documentLikes.deletedAt),
          ),
        )
        .limit(1);
      return rows.length > 0;
    }
    case 'post': {
      const rows = await executor
        .select({ id: postLikes.id })
        .from(postLikes)
        .where(
          and(eq(postLikes.userId, userId), eq(postLikes.postId, targetId), isNull(postLikes.deletedAt)),
        )
        .limit(1);
      return rows.length > 0;
    }
    case 'comment': {
      const rows = await executor
        .select({ id: commentLikes.id })
        .from(commentLikes)
        .where(
          and(
            eq(commentLikes.userId, userId),
            eq(commentLikes.commentId, targetId),
            isNull(commentLikes.deletedAt),
          ),
        )
        .limit(1);
      return rows.length > 0;
    }
  }
}

/**
 * Insert a like, or clear the soft-delete on one that already exists.
 *
 * Returns `'created'` when the counter should be incremented and `'unchanged'`
 * when it should not. The caller must not decide this itself: incrementing on a
 * re-like, or skipping the increment on a restore, is a permanent drift in
 * opposite directions.
 */
export async function upsertLike(
  tx: Tx,
  target: LikeTarget,
  targetId: string,
  userId: string,
): Promise<'created' | 'unchanged'> {
  switch (target) {
    case 'document': {
      const [row] = await tx
        .select({ id: documentLikes.id, deletedAt: documentLikes.deletedAt })
        .from(documentLikes)
        .where(and(eq(documentLikes.userId, userId), eq(documentLikes.documentId, targetId)))
        .limit(1);

      if (!row) {
        await tx.insert(documentLikes).values({ userId, documentId: targetId });
        return 'created';
      }
      if (row.deletedAt === null) return 'unchanged';

      await tx
        .update(documentLikes)
        .set({ deletedAt: null, updatedAt: new Date() })
        .where(eq(documentLikes.id, row.id));
      return 'created';
    }

    case 'post': {
      const [row] = await tx
        .select({ id: postLikes.id, deletedAt: postLikes.deletedAt })
        .from(postLikes)
        .where(and(eq(postLikes.userId, userId), eq(postLikes.postId, targetId)))
        .limit(1);

      if (!row) {
        await tx.insert(postLikes).values({ userId, postId: targetId });
        return 'created';
      }
      if (row.deletedAt === null) return 'unchanged';

      await tx
        .update(postLikes)
        .set({ deletedAt: null, updatedAt: new Date() })
        .where(eq(postLikes.id, row.id));
      return 'created';
    }

    case 'comment': {
      const [row] = await tx
        .select({ id: commentLikes.id, deletedAt: commentLikes.deletedAt })
        .from(commentLikes)
        .where(and(eq(commentLikes.userId, userId), eq(commentLikes.commentId, targetId)))
        .limit(1);

      if (!row) {
        await tx.insert(commentLikes).values({ userId, commentId: targetId });
        return 'created';
      }
      if (row.deletedAt === null) return 'unchanged';

      await tx
        .update(commentLikes)
        .set({ deletedAt: null, updatedAt: new Date() })
        .where(eq(commentLikes.id, row.id));
      return 'created';
    }
  }
}

/** Soft-delete a like. Returns false when the viewer had not liked it. */
export async function removeLike(
  tx: Tx,
  target: LikeTarget,
  targetId: string,
  userId: string,
): Promise<boolean> {
  switch (target) {
    case 'document': {
      const removed = await tx
        .update(documentLikes)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(documentLikes.userId, userId),
            eq(documentLikes.documentId, targetId),
            isNull(documentLikes.deletedAt),
          ),
        )
        .returning({ id: documentLikes.id });
      return removed.length > 0;
    }
    case 'post': {
      const removed = await tx
        .update(postLikes)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(
          and(eq(postLikes.userId, userId), eq(postLikes.postId, targetId), isNull(postLikes.deletedAt)),
        )
        .returning({ id: postLikes.id });
      return removed.length > 0;
    }
    case 'comment': {
      const removed = await tx
        .update(commentLikes)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(commentLikes.userId, userId),
            eq(commentLikes.commentId, targetId),
            isNull(commentLikes.deletedAt),
          ),
        )
        .returning({ id: commentLikes.id });
      return removed.length > 0;
    }
  }
}

/** Count of live likes, used by the drift check. */
export async function countLikes(
  executor: Executor,
  target: LikeTarget,
  targetId: string,
): Promise<number> {
  const table = target === 'document' ? documentLikes : target === 'post' ? postLikes : commentLikes;
  const column =
    target === 'document'
      ? documentLikes.documentId
      : target === 'post'
        ? postLikes.postId
        : commentLikes.commentId;

  const [row] = await executor
    .select({ value: sql<number>`count(*)::int` })
    .from(table)
    .where(and(eq(column, targetId), isNull(table.deletedAt)));

  return Number(row?.value ?? 0);
}
