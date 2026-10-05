import { sql } from 'drizzle-orm';

import { db } from '../../../db/client.js';
import { AppError } from '../../../lib/errors.js';
import {
  collectionVisibilityPredicate,
  documentVisibilityPredicate,
  postVisibilityPredicate,
  type Viewer,
} from './visibility.js';

/**
 * "May this viewer see this standalone target?"
 *
 * The write paths need this in a different shape from the read paths. A list
 * applies a predicate to a whole page in SQL; a `PUT /likes/post/:id` or
 * `POST /collections/:id/items` has exactly one id in hand and needs a yes/no
 * answer before it writes anything.
 *
 * Getting the answer from the same three predicates is the point. This file
 * exists because `bookmarks.service.ts` had grown its own private copy of this
 * lookup, and collections needed the identical thing — which is precisely the
 * duplication that makes one of them drift, and the one that drifts is always
 * the one nobody is looking at.
 *
 * The not-found message is per-kind, deliberately: "Không tìm thấy tài liệu" is
 * what an existing endpoint already says, and a shared generic message would be
 * a silent behavioural change for callers.
 */

/** Types the social API lets a user point at. */
export type SocialTargetKind = 'document' | 'post' | 'collection';

const NOT_FOUND_MESSAGE: Record<SocialTargetKind, string> = {
  document: 'Không tìm thấy tài liệu.',
  post: 'Không tìm thấy bài đăng.',
  collection: 'Không tìm thấy bộ sưu tập.',
};

/**
 * Answer without throwing.
 *
 * `SELECT EXISTS (...)` rather than fetching a row and checking its length:
 * the question is a boolean, and asking Postgres for a boolean lets it stop at
 * the first match instead of materialising a row the caller will discard.
 */
export async function targetVisibleTo(
  kind: SocialTargetKind,
  targetId: string,
  viewer: Viewer,
): Promise<boolean> {
  if (kind === 'document') {
    const { rows } = await db.execute<{ ok: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM documents
         WHERE documents.id = ${targetId}
           AND ${documentVisibilityPredicate(viewer)}
      ) AS ok
    `);
    return Boolean(rows[0]?.ok);
  }

  if (kind === 'post') {
    const { rows } = await db.execute<{ ok: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM posts
         WHERE posts.id = ${targetId}
           AND ${postVisibilityPredicate(viewer)}
      ) AS ok
    `);
    return Boolean(rows[0]?.ok);
  }

  const { rows } = await db.execute<{ ok: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM collections
       WHERE collections.id = ${targetId}
         AND ${collectionVisibilityPredicate(viewer)}
    ) AS ok
  `);
  return Boolean(rows[0]?.ok);
}

/**
 * Throw `NOT_FOUND` unless the viewer may see the target.
 *
 * Always `NOT_FOUND`, never `FORBIDDEN`. A 403 on an id the caller cannot see
 * confirms the id exists, which turns an opaque uuid into an oracle: probe a
 * thousand ids and the ones that answer 403 instead of 404 are real documents.
 * The reference documents module makes the same choice for the same reason.
 */
export async function assertTargetVisibleTo(
  kind: SocialTargetKind,
  targetId: string,
  viewer: Viewer,
): Promise<void> {
  if (!(await targetVisibleTo(kind, targetId, viewer))) {
    throw new AppError('NOT_FOUND', NOT_FOUND_MESSAGE[kind]);
  }
}
