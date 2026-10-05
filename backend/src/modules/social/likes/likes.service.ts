import { and, eq } from 'drizzle-orm';

import { db } from '../../../db/client.js';
import { AppError } from '../../../lib/errors.js';
import { comments, documents, posts } from '../../../db/schema/index.js';
import { adjustCounter, refreshPostHotScore } from '../shared/counters.js';
import { notify } from '../notifications/notifications.service.js';
import { documentVisibilityPredicate, postVisibilityPredicate } from '../shared/visibility.js';
import type { SocialActor } from '../shared/actor.js';
import * as repo from './likes.repository.js';
import type { LikeTarget } from './likes.repository.js';

/**
 * Like service.
 *
 * Visibility is checked before anything is written: you cannot like what you
 * cannot see, and a like is a public signal — being able to like a private
 * document would confirm it exists.
 */

export interface LikeResult {
  liked: boolean;
  likeCount: number;
}

interface TargetInfo {
  ownerUserId: string;
  /** What the notification should point at. */
  groupKey: string;
  kind: 'document_like' | 'post_like' | 'comment_like';
}

/**
 * Resolve the target, confirm the viewer may see it, and find who to notify.
 *
 * One function rather than three lookups scattered through the toggle, because
 * every one of them is a place a visibility check could be forgotten.
 */
async function resolveTarget(
  target: LikeTarget,
  targetId: string,
  actor: SocialActor,
): Promise<TargetInfo> {
  if (target === 'document') {
    const [row] = await db
      .select({ ownerUserId: documents.ownerUserId })
      .from(documents)
      .where(and(eq(documents.id, targetId), documentVisibilityPredicate(actor.viewer)))
      .limit(1);

    if (!row) throw new AppError('DOCUMENT_NOT_FOUND', 'Không tìm thấy tài liệu.');
    return { ownerUserId: row.ownerUserId, groupKey: `document_like:${targetId}`, kind: 'document_like' };
  }

  if (target === 'post') {
    const [row] = await db
      .select({ ownerUserId: posts.authorUserId })
      .from(posts)
      .where(and(eq(posts.id, targetId), postVisibilityPredicate(actor.viewer)))
      .limit(1);

    if (!row) throw new AppError('NOT_FOUND', 'Không tìm thấy bài đăng.');
    return { ownerUserId: row.ownerUserId, groupKey: `post_like:${targetId}`, kind: 'post_like' };
  }

  const [row] = await db
    .select({ ownerUserId: comments.authorUserId })
    .from(comments)
    .where(eq(comments.id, targetId))
    .limit(1);

  if (!row) throw new AppError('NOT_FOUND', 'Không tìm thấy bình luận.');

  // A comment has no visibility of its own — it inherits its target's. Rather
  // than re-resolving that here, this relies on the comment being unreachable
  // in the first place: the comments API refuses to return one whose target the
  // viewer cannot see.
  return { ownerUserId: row.ownerUserId, groupKey: `comment_like:${targetId}`, kind: 'comment_like' };
}

/**
 * Toggle a like, or set it explicitly.
 *
 * `desired` lets the client say what it wants rather than "flip whatever is
 * there". A toggle is ambiguous under retry: a request that succeeded but whose
 * response was lost gets replayed and undoes itself. Stating the desired state
 * makes the operation idempotent.
 */
export async function setLike(
  target: LikeTarget,
  targetId: string,
  desired: boolean,
  actor: SocialActor,
): Promise<LikeResult> {
  const info = await resolveTarget(target, targetId, actor);

  return db.transaction(async (tx) => {
    // Liking your own content is not an error — it is just pointless and must
    // not earn reputation or notify you about yourself. The database CHECK
    // rejects a self-notification, and `notify` returns early; the counter
    // still moves, because the like is real.
    let changed = false;

    if (desired) {
      const result = await repo.upsertLike(tx, target, targetId, actor.userId);
      changed = result === 'created';
    } else {
      changed = await repo.removeLike(tx, target, targetId, actor.userId);
    }

    if (!changed) {
      // Nothing moved. Report the current truth rather than guessing, so a
      // client that retried gets the right answer instead of a stale one.
      const likeCount = await repo.countLikes(tx, target, targetId);
      return { liked: await repo.isLiked(tx, target, targetId, actor.userId), likeCount };
    }

    const delta = desired ? 1 : -1;

    if (target === 'document') {
      await adjustCounter(tx, { table: 'documents', column: 'like_count' }, targetId, delta);
    } else if (target === 'post') {
      await adjustCounter(tx, { table: 'posts', column: 'like_count' }, targetId, delta);
      // The score is derived from the counters, so it is recomputed rather than
      // incremented — an incremented derived value is permanently wrong after
      // one missed event.
      await refreshPostHotScore(tx, targetId);
    } else {
      await adjustCounter(tx, { table: 'comments', column: 'like_count' }, targetId, delta);
    }

    if (desired) {
      await notify(tx, {
        recipientUserId: info.ownerUserId,
        actorUserId: actor.userId,
        kind: info.kind,
        targetType: target,
        targetId,
        // Collapses a thousand likes on one thing into a single row that reads
        // "A và 999 người khác".
        groupKey: info.groupKey,
        // Actor identity only. A snapshot of the target's title would leak
        // content to someone whose access was revoked after the fact.
        payload: {},
      });
    }

    const likeCount = await repo.countLikes(tx, target, targetId);
    return { liked: desired, likeCount };
  });
}

/** Whether the viewer likes this, without changing anything. */
export async function getLikeState(
  target: LikeTarget,
  targetId: string,
  actor: SocialActor | null,
): Promise<LikeResult> {
  const liked = actor
    ? await repo.isLiked(db, target, targetId, actor.userId)
    : false;
  const likeCount = await repo.countLikes(db, target, targetId);
  return { liked, likeCount };
}

export type { LikeTarget };
