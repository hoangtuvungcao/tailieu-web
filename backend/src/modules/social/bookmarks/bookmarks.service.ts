import { sql, type SQL } from 'drizzle-orm';

import { db } from '../../../db/client.js';
import { paginate, type PaginationInput } from '../../../lib/pagination.js';
import { recordTrendSignal, TREND_WEIGHTS } from '../feed/trending.js';
import type { SocialActor } from '../shared/actor.js';
import { isoDateTime as iso } from '../shared/dates.js';
import { hydrateTargets, type TargetSummary } from '../shared/hydrate.js';
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
  folder: string | null | undefined,
  actor: SocialActor,
): Promise<{ bookmarked: boolean }> {
  // Bookmarking something you cannot see is neither useful nor harmless: it
  // would confirm the target exists.
  if (desired) await assertTargetVisible(target, targetId, actor);

  const changed = await db.transaction(async (tx) => {
    return repo.setBookmark(tx, actor.userId, target, targetId, desired, folder);
  });

  // Only for posts, and only when something actually changed — a repeated
  // bookmark of the same post is not fresh engagement.
  if (changed && desired && target === 'post') {
    await recordTrendSignal(targetId, TREND_WEIGHTS.bookmark);
  }

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

export interface BookmarkItemDto {
  id: string;
  folder: string | null;
  savedAt: string;
  /** The shared card shape — the same one collections render for a pointer. */
  target: TargetSummary;
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

  // This list used to come back as bare pointers — `{ targetType, targetId }`
  // and nothing else. Safe, because the filter above ran, but not renderable:
  // no title, no owner, nothing a page could show. The titles come from the
  // shared hydrator, which applies each owning module's predicate a second time.
  const { summaries, missing } = await hydrateTargets(items, actor.viewer);

  if (missing.length > 0) {
    // Should be impossible — the identical predicates just filtered this page.
    // A drop means the two disagree about the same row, and the safe direction
    // (fewer rows) is also the invisible one.
    console.warn(
      `[bookmarks] ${missing.length} bookmark(s) passed the visibility filter but were filtered out during hydration: ${missing.join(', ')}`,
    );
  }

  const hydrated: BookmarkItemDto[] = items.flatMap((item) => {
    const target = summaries.get(item.id);
    return target
      ? [{ id: item.id, folder: item.folder, savedAt: iso(item.createdAt), target }]
      : [];
  });

  return paginate(hydrated, total, pagination);
}

export async function listFolders(actor: SocialActor) {
  // The same predicate the list uses, for the same reason. Counting every row
  // in a folder — including bookmarks whose targets the reader has since lost
  // access to — would put "Ôn thi (5)" above a list of three, which is the
  // defect this module already went to some trouble to avoid in the list
  // itself.
  return repo.listFolders(actor.userId, bookmarkTargetVisible(actor.viewer));
}
