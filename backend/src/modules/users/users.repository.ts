import { and, count, eq, isNull } from 'drizzle-orm';

import { db } from '../../db/client.js';
import { documents, faculties, posts, programs, users } from '../../db/schema/index.js';
import {
  documentVisibilityPredicate,
  postVisibilityPredicate,
  type Viewer,
} from '../social/shared/visibility.js';
import type { Executor } from '../documents/documents.repository.js';

/**
 * Public profiles.
 *
 * A profile is a *view over columns someone else owns*, which makes it the
 * easiest place in the application to leak something by accident. Three rules
 * follow from that:
 *
 *   1. ANONYMISED ACCOUNTS HAVE NO PROFILE. An erasure request clears the email
 *      and sets `anonymized_at`; returning the row anyway would keep a ghost
 *      name and bio reachable at a stable URL after the account asked to be
 *      forgotten. Every read here filters on `anonymized_at IS NULL`.
 *
 *   2. THE COLUMN LIST IS WRITTEN OUT, NOT SELECTED WHOLESALE. `select()` with
 *      no argument would return `email`, `student_code`, `token_version` and
 *      everything else added to `users` later. Listing the public columns means
 *      a new column is private until somebody decides otherwise, which is the
 *      direction that fails safe.
 *
 *   3. COUNTS ARE VIEWER-RELATIVE. A profile announces how many posts and
 *      documents somebody has, and then links to them. Counting rows the reader
 *      cannot open would put a headline above a shorter list — the same defect
 *      as the comment count that disagreed with its thread.
 */

/** The columns that are public, and nothing else. */
const profileColumns = {
  id: users.id,
  username: users.username,
  displayName: users.displayName,
  bio: users.bio,
  avatarUrl: users.avatarUrl,
  coverUrl: users.coverUrl,
  enrollmentYear: users.enrollmentYear,
  createdAt: users.createdAt,
  facultyId: faculties.id,
  facultyName: faculties.name,
  facultyCode: faculties.code,
  programId: programs.id,
  programName: programs.name,
  programCode: programs.code,
};

export interface ProfileRow {
  id: string;
  username: string | null;
  displayName: string;
  bio: string | null;
  avatarUrl: string | null;
  coverUrl: string | null;
  enrollmentYear: number | null;
  createdAt: Date | string;
  facultyId: string | null;
  facultyName: string | null;
  facultyCode: string | null;
  programId: string | null;
  programName: string | null;
  programCode: string | null;
}

export async function findProfileById(
  userId: string,
  executor: Executor = db,
): Promise<ProfileRow | null> {
  const [row] = await executor
    .select(profileColumns)
    .from(users)
    // LEFT JOINs, not INNER: most accounts have no faculty or programme set,
    // and an inner join would return nothing at all for them rather than a
    // profile with those two fields absent.
    .leftJoin(faculties, eq(faculties.id, users.primaryFacultyId))
    .leftJoin(programs, eq(programs.id, users.primaryProgramId))
    .where(and(eq(users.id, userId), isNull(users.anonymizedAt)))
    .limit(1);

  return row ?? null;
}

/**
 * Posts by this author that *this viewer* may read.
 *
 * The predicate is the posts module's own, so the number here cannot disagree
 * with the list the profile links to.
 */
export async function countVisiblePosts(
  authorUserId: string,
  viewer: Viewer,
  executor: Executor = db,
): Promise<number> {
  const [row] = await executor
    .select({ value: count() })
    .from(posts)
    .where(and(eq(posts.authorUserId, authorUserId), postVisibilityPredicate(viewer)));

  return Number(row?.value ?? 0);
}

/** Documents owned by this account that *this viewer* may open. */
export async function countVisibleDocuments(
  ownerUserId: string,
  viewer: Viewer,
  executor: Executor = db,
): Promise<number> {
  const [row] = await executor
    .select({ value: count() })
    .from(documents)
    .where(and(eq(documents.ownerUserId, ownerUserId), documentVisibilityPredicate(viewer)));

  return Number(row?.value ?? 0);
}
