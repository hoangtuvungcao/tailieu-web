import { and, count, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';

import { db } from '../../../db/client.js';
import { bookmarks } from '../../../db/schema/index.js';
import { toOffset, type PaginationInput } from '../../../lib/pagination.js';
import type { Executor, Tx } from '../../documents/documents.repository.js';

/**
 * Bookmarks.
 *
 * A bookmark is a private pointer to something. The table is polymorphic —
 * `(target_type, target_id)` — because a bookmark list is meant to mix
 * documents, posts and collections, and three parallel tables would make "my
 * bookmarks, newest first" a UNION.
 *
 * Polymorphism costs a foreign key, so the *only* thing that keeps a bookmark
 * list honest is filtering the target at read time. That filter lives in the
 * service, using the owning module's visibility predicate, and is the reason
 * this repository exposes nothing that returns a hydrated target.
 */

export type BookmarkTarget = 'document' | 'post' | 'collection';

/**
 * Add or remove a bookmark. Returns true when the relation changed.
 *
 * Restore-on-rebookmark, matching likes and follows: re-bookmarking clears
 * `deleted_at` rather than inserting a second row, so the partial unique stays
 * meaningful and no duplicate accumulates.
 */
export async function setBookmark(
  tx: Tx,
  userId: string,
  targetType: BookmarkTarget,
  targetId: string,
  desired: boolean,
  folder: string | null,
): Promise<boolean> {
  const [existing] = await tx
    .select({ id: bookmarks.id, deletedAt: bookmarks.deletedAt })
    .from(bookmarks)
    .where(
      and(
        eq(bookmarks.userId, userId),
        eq(bookmarks.targetType, targetType),
        eq(bookmarks.targetId, targetId),
      ),
    )
    .limit(1);

  if (desired) {
    if (!existing) {
      await tx.insert(bookmarks).values({ userId, targetType, targetId, folder });
      return true;
    }
    if (existing.deletedAt === null) {
      // Already bookmarked. The folder may still have changed — moving a
      // bookmark between folders is a real edit that should not be a no-op.
      if (folder !== null) {
        await tx.update(bookmarks).set({ folder }).where(eq(bookmarks.id, existing.id));
      }
      return false;
    }
    await tx
      .update(bookmarks)
      .set({ deletedAt: null, folder })
      .where(eq(bookmarks.id, existing.id));
    return true;
  }

  if (!existing || existing.deletedAt !== null) return false;

  await tx.update(bookmarks).set({ deletedAt: new Date() }).where(eq(bookmarks.id, existing.id));
  return true;
}

export async function isBookmarked(
  executor: Executor,
  userId: string,
  targetType: BookmarkTarget,
  targetId: string,
): Promise<boolean> {
  const rows = await executor
    .select({ id: bookmarks.id })
    .from(bookmarks)
    .where(
      and(
        eq(bookmarks.userId, userId),
        eq(bookmarks.targetType, targetType),
        eq(bookmarks.targetId, targetId),
        isNull(bookmarks.deletedAt),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * The viewer's bookmarks, newest first.
 *
 * `targetVisibility` is a SQL fragment supplied by the caller and applied
 * **here, in SQL** — not as a post-filter in JavaScript. It exists so a
 * bookmarked document the viewer can no longer read simply is not in the list.
 * Returning it and hiding it in the UI would still leak the title through the
 * API, which is the whole risk with a polymorphic pointer.
 */
export async function listBookmarks(
  userId: string,
  pagination: PaginationInput,
  targetVisibility: SQL | undefined,
  folder: string | undefined,
  executor: Executor = db,
) {
  const predicates: SQL[] = [eq(bookmarks.userId, userId), isNull(bookmarks.deletedAt)];
  if (folder !== undefined) predicates.push(eq(bookmarks.folder, folder));
  if (targetVisibility) predicates.push(targetVisibility);

  const where = and(...predicates)!;

  const [rows, [totalRow]] = await Promise.all([
    executor
      .select({
        id: bookmarks.id,
        targetType: bookmarks.targetType,
        targetId: bookmarks.targetId,
        folder: bookmarks.folder,
        createdAt: bookmarks.createdAt,
      })
      .from(bookmarks)
      .where(where)
      .orderBy(desc(bookmarks.createdAt), desc(bookmarks.id))
      .limit(pagination.limit)
      .offset(toOffset(pagination)),
    executor.select({ value: count() }).from(bookmarks).where(where),
  ]);

  return { items: rows, total: Number(totalRow?.value ?? 0) };
}

/** Distinct folders, for the sidebar. */
export async function listFolders(userId: string, executor: Executor = db) {
  const rows = await executor
    .select({ folder: bookmarks.folder, total: sql<number>`count(*)::int` })
    .from(bookmarks)
    .where(
      and(
        eq(bookmarks.userId, userId),
        isNull(bookmarks.deletedAt),
        sql`${bookmarks.folder} IS NOT NULL`,
      ),
    )
    .groupBy(bookmarks.folder)
    .orderBy(bookmarks.folder);

  return rows.map((r) => ({ folder: r.folder!, total: Number(r.total) }));
}
