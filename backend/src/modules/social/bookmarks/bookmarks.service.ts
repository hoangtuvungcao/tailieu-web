import { sql, type SQL } from 'drizzle-orm';

import { db } from '../../../db/client.js';
import { paginate, type PaginationInput } from '../../../lib/pagination.js';
import type { SocialActor } from '../shared/actor.js';
import { assertTargetVisibleTo } from '../shared/targets.js';
import {
  collectionVisibilityPredicate,
  documentVisibilityPredicate,
  postVisibilityPredicate,
  type Viewer,
} from '../shared/visibility.js';
import * as repo from './bookmarks.repository.js';
import type { BookmarkTarget } from './bookmarks.repository.js';

/**
 * Bookmark service.
 *
 * The critical piece here is `bookmarkTargetVisible`. A bookmark is a
 * polymorphic pointer, and the pointer is what leaks: a user bookmarks a
 * document, the owner later makes it private, and the bookmark list must stop
 * showing it. Filtering after the query would still send the title in the
 * response body.
 *
 * So the filter is built as one SQL fragment — three EXISTS clauses, one per
 * target kind, each running the *owning module's* predicate — and applied in
 * the WHERE clause. A bookmark whose target is no longer visible is not
 * returned at all.
 */

/**
 * "Is this bookmark's target still something the viewer may see?"
 *
 * Each branch reuses the predicate from the module that owns visibility, so
 * there is no second implementation of the document rule to drift.
 */
function bookmarkTargetVisible(viewer: Viewer): SQL {
  return sql`(
    (${sql.raw('bookmarks')}.target_type = 'document' AND EXISTS (
      SELECT 1 FROM documents
       WHERE documents.id = bookmarks.target_id
         AND ${documentVisibilityPredicate(viewer)}
    ))
    OR (bookmarks.target_type = 'post' AND EXISTS (
      SELECT 1 FROM posts
       WHERE posts.id = bookmarks.target_id
         AND ${postVisibilityPredicate(viewer)}
    ))
    OR (bookmarks.target_type = 'collection' AND EXISTS (
      SELECT 1 FROM collections
       WHERE collections.id = bookmarks.target_id
         AND ${collectionVisibilityPredicate(viewer)}
    ))
  )`;
}

/** Confirm a single bookmark target is visible, for the write path. */
async function assertTargetVisible(
  target: BookmarkTarget,
  targetId: string,
  actor: SocialActor,
): Promise<void> {
  // Delegated rather than reimplemented. This function used to carry its own
  // copy of the three EXISTS lookups, which is the same code now shared with
  // collections — two copies of a visibility rule is one copy too many.
  await assertTargetVisibleTo(target, targetId, actor.viewer);
}

export async function setBookmark(
  target: BookmarkTarget,
  targetId: string,
  desired: boolean,
  folder: string | null,
  actor: SocialActor,
): Promise<{ bookmarked: boolean }> {
  // Bookmarking something you cannot see is neither useful nor harmless: it
  // would confirm the target exists.
  if (desired) await assertTargetVisible(target, targetId, actor);

  await db.transaction(async (tx) => {
    await repo.setBookmark(tx, actor.userId, target, targetId, desired, folder);
  });

  return { bookmarked: desired };
}

export async function getBookmarkState(
  target: BookmarkTarget,
  targetId: string,
  actor: SocialActor | null,
): Promise<{ bookmarked: boolean }> {
  if (!actor) return { bookmarked: false };
  return { bookmarked: await repo.isBookmarked(db, actor.userId, target, targetId) };
}

export async function listBookmarks(
  pagination: PaginationInput,
  folder: string | undefined,
  actor: SocialActor,
) {
  // The viewer's own predicates, so a bookmarked item they have since lost
  // access to disappears from the list rather than being hidden by the client.
  const visible = bookmarkTargetVisible(actor.viewer);
  const { items, total } = await repo.listBookmarks(actor.userId, pagination, visible, folder);
  return paginate(items, total, pagination);
}

export async function listFolders(actor: SocialActor) {
  return repo.listFolders(actor.userId);
}
