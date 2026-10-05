import { and, eq, isNull } from 'drizzle-orm';

import { db } from '../../../db/client.js';
import { AppError } from '../../../lib/errors.js';
import { paginate, type PaginationInput } from '../../../lib/pagination.js';
import { users } from '../../../db/schema/index.js';
import { notify, retractUnread } from '../notifications/notifications.service.js';
import type { SocialActor } from '../shared/actor.js';
import * as repo from './follows.repository.js';

/**
 * Follow service.
 *
 * Following is a public, one-way relation. The rule that matters: you can only
 * follow an account that still exists — an anonymised account has no profile,
 * and letting people follow it would put a ghost in their following list.
 */
export async function setFollow(
  targetUserId: string,
  desired: boolean,
  actor: SocialActor,
): Promise<{ following: boolean; followers: number }> {
  if (targetUserId === actor.userId) {
    throw new AppError('CANNOT_MODIFY_SELF', 'Bạn không thể tự theo dõi mình.');
  }

  const [target] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, targetUserId), isNull(users.anonymizedAt)))
    .limit(1);

  if (!target) throw new AppError('USER_NOT_FOUND', 'Không tìm thấy người dùng.');

  // A follow is once-per-relationship, so it collapses on the pair rather than
  // on a target. That key is also what makes retraction exact.
  const groupKey = `follow:${actor.userId}`;

  await db.transaction(async (tx) => {
    const changed = await repo.setFollow(tx, actor.userId, targetUserId, desired);
    if (!changed) return;

    if (desired) {
      await notify(tx, {
        recipientUserId: targetUserId,
        actorUserId: actor.userId,
        kind: 'follow',
        targetType: 'user',
        targetId: actor.userId,
        groupKey,
        payload: {},
      });
      return;
    }

    // Unfollowing withdraws the unread notification. Leaving it would announce
    // a relationship that no longer exists — and because the collapse key is
    // the same, a later re-follow would revive the row reading "2", a count
    // that never meant anything.
    await retractUnread(tx, targetUserId, groupKey);
  });

  const counts = await repo.countsFor(targetUserId);
  return { following: desired, followers: counts.followers };
}

export async function getFollowState(
  targetUserId: string,
  actor: SocialActor | null,
) {
  return repo.profileFollowState(actor?.userId ?? null, targetUserId);
}

export async function listFollowing(userId: string, pagination: PaginationInput) {
  const { items, total } = await repo.listFollowing(userId, pagination);
  return paginate(items, total, pagination);
}

export async function listFollowers(userId: string, pagination: PaginationInput) {
  const { items, total } = await repo.listFollowers(userId, pagination);
  return paginate(items, total, pagination);
}
