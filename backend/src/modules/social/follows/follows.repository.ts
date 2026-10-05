import { and, count, desc, eq, isNull, sql } from 'drizzle-orm';

import { db } from '../../../db/client.js';
import { follows, users } from '../../../db/schema/index.js';
import { toOffset, type PaginationInput } from '../../../lib/pagination.js';
import type { Executor, Tx } from '../../documents/documents.repository.js';

/**
 * Follows.
 *
 * Follower counts are COMPUTED, not denormalised — a deliberate exception to
 * how the notification badge works.
 *
 * The distinction is read frequency. The unread badge is polled every 30-60
 * seconds by every open tab, so `count(*)` there would be a scan on a timer;
 * it earns a column. A follower count is read when somebody opens a profile,
 * which is rare and already a page load. A column would need maintaining from
 * several paths (follow, unfollow, account deletion, a merge) and each is a
 * chance to drift — for a number that is cheap to compute correctly.
 */

/** Follow or unfollow, idempotently. Returns true when the relation changed. */
export async function setFollow(
  tx: Tx,
  followerUserId: string,
  followeeUserId: string,
  desired: boolean,
): Promise<boolean> {
  // The database CHECK rejects this too; failing here gives a usable error.
  if (followerUserId === followeeUserId) return false;

  const [existing] = await tx
    .select({ id: follows.id, deletedAt: follows.deletedAt })
    .from(follows)
    .where(
      and(eq(follows.followerUserId, followerUserId), eq(follows.followeeUserId, followeeUserId)),
    )
    .limit(1);

  if (desired) {
    if (!existing) {
      await tx.insert(follows).values({ followerUserId, followeeUserId });
      return true;
    }
    // Already following. Restore-on-refollow, matching likes: clearing
    // `deleted_at` keeps the partial unique meaningful and the row count honest.
    if (existing.deletedAt === null) return false;

    await tx.update(follows).set({ deletedAt: null }).where(eq(follows.id, existing.id));
    return true;
  }

  if (!existing || existing.deletedAt !== null) return false;

  await tx.update(follows).set({ deletedAt: new Date() }).where(eq(follows.id, existing.id));
  return true;
}

export async function isFollowing(
  executor: Executor,
  followerUserId: string,
  followeeUserId: string,
): Promise<boolean> {
  const rows = await executor
    .select({ id: follows.id })
    .from(follows)
    .where(
      and(
        eq(follows.followerUserId, followerUserId),
        eq(follows.followeeUserId, followeeUserId),
        isNull(follows.deletedAt),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** Users this account follows, newest first. */
export async function listFollowing(
  userId: string,
  pagination: PaginationInput,
  executor: Executor = db,
) {
  const where = and(eq(follows.followerUserId, userId), isNull(follows.deletedAt))!;

  const [rows, [totalRow]] = await Promise.all([
    executor
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        bio: users.bio,
        followedAt: follows.createdAt,
      })
      .from(follows)
      .innerJoin(users, eq(users.id, follows.followeeUserId))
      // Anonymised accounts are not shown — their profile no longer exists.
      .where(and(where, isNull(users.anonymizedAt)))
      .orderBy(desc(follows.createdAt))
      .limit(pagination.limit)
      .offset(toOffset(pagination)),
    executor.select({ value: count() }).from(follows).where(where),
  ]);

  return { items: rows, total: Number(totalRow?.value ?? 0) };
}

/** Users who follow this account. */
export async function listFollowers(
  userId: string,
  pagination: PaginationInput,
  executor: Executor = db,
) {
  const where = and(eq(follows.followeeUserId, userId), isNull(follows.deletedAt))!;

  const [rows, [totalRow]] = await Promise.all([
    executor
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        bio: users.bio,
        followedAt: follows.createdAt,
      })
      .from(follows)
      .innerJoin(users, eq(users.id, follows.followerUserId))
      .where(and(where, isNull(users.anonymizedAt)))
      .orderBy(desc(follows.createdAt))
      .limit(pagination.limit)
      .offset(toOffset(pagination)),
    executor.select({ value: count() }).from(follows).where(where),
  ]);

  return { items: rows, total: Number(totalRow?.value ?? 0) };
}

export interface FollowCounts {
  followers: number;
  following: number;
}

/** Both counts in one round trip rather than two. */
export async function countsFor(userId: string, executor: Executor = db): Promise<FollowCounts> {
  const [row] = await executor
    .select({
      followers: sql<number>`count(*) FILTER (WHERE followee_user_id = ${userId})::int`,
      following: sql<number>`count(*) FILTER (WHERE follower_user_id = ${userId})::int`,
    })
    .from(follows)
    .where(
      and(
        isNull(follows.deletedAt),
        sql`(${follows.followerUserId} = ${userId} OR ${follows.followeeUserId} = ${userId})`,
      ),
    );

  return {
    followers: Number(row?.followers ?? 0),
    following: Number(row?.following ?? 0),
  };
}

/** Follow state plus counts, for a profile header. */
export async function profileFollowState(
  viewerUserId: string | null,
  targetUserId: string,
): Promise<FollowCounts & { isFollowing: boolean }> {
  const [counts, following] = await Promise.all([
    countsFor(targetUserId),
    viewerUserId ? isFollowing(db, viewerUserId, targetUserId) : Promise.resolve(false),
  ]);
  return { ...counts, isFollowing: following };
}
