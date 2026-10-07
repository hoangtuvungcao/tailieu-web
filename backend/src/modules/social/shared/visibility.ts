import { and, inArray, or, sql, type SQL } from 'drizzle-orm';

import { collectionItems, collections, posts } from '../../../db/schema/index.js';
import { documents } from '../../../db/schema/index.js';

/**
 * Visibility predicates for every social surface.
 *
 * ONE file, because every social feature is a way to expose content
 * indirectly. A like list, a collection, a bookmark list, a follower feed, a
 * notification — each of them hydrates a target and shows it to someone. If any
 * one of them hydrates without applying the viewer-dependent predicate, or
 * filters afterwards in JavaScript, private documents leak.
 *
 * That is the highest-severity risk in the whole social feature set, and the
 * only durable defence is that the predicate lives here and every repository
 * function that returns a target takes a `viewer` and applies it **in SQL**.
 *
 * The document predicate is re-exported rather than reimplemented. Two
 * implementations of the same rule drift, and the one that drifts is always the
 * one nobody is looking at.
 */

export interface Viewer {
  userId: string | null;
  /** Platform-wide moderation rights. */
  isModerator: boolean;
  /** Faculty ids for a faculty-scoped moderator. */
  facultyIds: string[];
  /** The viewer's own faculty/program, used for `internal` scoping. */
  facultyId?: string | null;
  programId?: string | null;
}

/** The empty viewer: anonymous. */
export const anonymousViewer: Viewer = {
  userId: null,
  isModerator: false,
  facultyIds: [],
};

/**
 * Re-exported from the documents module so there is exactly one document
 * visibility rule in the codebase.
 *
 * Imported as well as re-exported: `export ... from` creates no local binding,
 * and `collectionItemVisibleTo` below needs to *call* it — which is the whole
 * point of re-exporting rather than reimplementing.
 */
export { visibilityPredicate as documentVisibilityPredicate } from '../../documents/documents.repository.js';
import { visibilityPredicate as documentVisibilityPredicate } from '../../documents/documents.repository.js';

/**
 * "May this viewer see this post?"
 *
 * Same shape as the document rule, deliberately — a post and a document at the
 * same visibility level should behave identically, and a user who can read an
 * `internal` document should be able to read an `internal` post.
 *
 * `moderation_state` is part of the predicate rather than a separate filter, so
 * a hidden post can never be returned by a query that forgot to check it.
 */
export function postVisibilityPredicate(viewer: Viewer): SQL {
  const clauses: SQL[] = [
    sql`${posts.moderationState} = 'visible' AND ${posts.visibility} = 'public'`,
  ];

  if (viewer.userId) {
    clauses.push(
      sql`${posts.moderationState} = 'visible' AND ${posts.visibility} = 'internal'`,
    );
    // Always see your own, whatever state it is in. Losing sight of your own
    // hidden post with no explanation is worse than the hiding.
    clauses.push(sql`${posts.authorUserId} = ${viewer.userId}`);
  }

  if (viewer.isModerator) {
    clauses.push(sql`true`);
  } else if (viewer.facultyIds.length > 0) {
    // `inArray`, not `= ANY($1::uuid[])`. See documents.repository.ts: a
    // JavaScript array does not bind as a Postgres array literal, and a
    // single-element array arrives as the bare value.
    clauses.push(inArray(posts.facultyId, viewer.facultyIds));
  }

  return and(sql`${posts.deletedAt} IS NULL`, or(...clauses))!;
}

/**
 * "May this viewer see this collection?"
 *
 * Private is the default for a collection — a personal reading list is private
 * until its owner says otherwise, which is the opposite of a document's
 * `internal` default. Getting that backwards would publish every draft
 * collection the moment it was created.
 */
export function collectionVisibilityPredicate(viewer: Viewer): SQL {
  const clauses: SQL[] = [sql`${collections.visibility} = 'public'`];

  if (viewer.userId) {
    clauses.push(sql`${collections.visibility} = 'internal'`);
    clauses.push(sql`${collections.ownerUserId} = ${viewer.userId}`);
  }

  return and(sql`${collections.deletedAt} IS NULL`, or(...clauses))!;
}

/**
 * Filter collection items down to those whose target the viewer may see.
 *
 * A collection is a *list of pointers*, and the pointers are what leak. Someone
 * can add a private document to their public collection — either by mistake or
 * deliberately to launder access — so an item's visibility is the visibility of
 * what it points at, not of the collection.
 *
 * Documents are the case that matters most — they are the type with something
 * genuinely non-public to lose — but posts and nested collections carry the
 * same rule, and an item pointing at something with no matching branch would
 * fall through to "visible", which is the one answer that must never be a
 * default. Every type the API accepts is therefore handled explicitly, and a
 * new one must be added here before it can be stored.
 */
export function collectionItemVisibleTo(viewer: Viewer): SQL {
  // Each branch delegates to the *owning module's* predicate, which qualifies
  // its columns as `"documents"."col"` / `"posts"."col"`. That qualification is
  // what makes them usable verbatim inside a correlated subquery: the
  // subquery's own `FROM` binds the name, so the outer `collection_items` row
  // is untouched.
  //
  // An earlier version of this function hand-wrote a second copy of the
  // document rule for exactly this reason. It had already drifted — it was
  // missing the faculty-scoped-moderator branch — which is the failure the
  // comment at the top of this file predicts, reproduced in the file itself.
  // There is now one implementation per target kind and no local copies.
  return or(
    and(
      sql`${collectionItems.targetType} = 'document'`,
      sql`EXISTS (
        SELECT 1 FROM ${documents}
         WHERE ${documents.id} = ${collectionItems.targetId}
           AND ${documentVisibilityPredicate(viewer)}
      )`,
    ),
    and(
      sql`${collectionItems.targetType} = 'post'`,
      sql`EXISTS (
        SELECT 1 FROM ${posts}
         WHERE ${posts.id} = ${collectionItems.targetId}
           AND ${postVisibilityPredicate(viewer)}
      )`,
    ),
    and(
      sql`${collectionItems.targetType} = 'collection'`,
      sql`EXISTS (
        SELECT 1 FROM ${collections}
         WHERE ${collections.id} = ${collectionItems.targetId}
           AND ${collectionVisibilityPredicate(viewer)}
      )`,
    ),
  )!;
}

/** Convenience: is this a moderator with platform-wide reach? */
export function isGlobalModerator(viewer: Viewer): boolean {
  return viewer.isModerator;
}
