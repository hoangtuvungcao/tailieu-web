import { and, eq, isNull, sql } from 'drizzle-orm';

import { db } from '../../../db/client.js';
import { notifications, users } from '../../../db/schema/index.js';
import type { Tx } from '../../documents/documents.repository.js';
import { adjustCounter } from '../shared/counters.js';

/**
 * Notification creation.
 *
 * Three rules, each of which exists because the obvious alternative breaks at
 * scale:
 *
 *   1. NEVER ONE ROW PER RECIPIENT FOR A FAN-OUT EVENT. "X posted" produces no
 *      notification at all — followers see it through the feed query. A post by
 *      someone with 5,000 followers inserting 5,000 rows is the classic way a
 *      social system falls over.
 *
 *   2. COLLAPSE REPEATED EVENTS ON ONE THING. A thousand likes on a post is one
 *      notification ("A và 999 người khác"), enforced by the partial unique on
 *      (recipient, group_key) WHERE read_at IS NULL. It re-arms after the user
 *      reads it, so the next like starts a fresh row rather than reviving a
 *      read one.
 *
 *   3. NEVER YOURSELF. The database CHECK rejects it, and this returns early so
 *      the caller does not have to remember.
 */

export type NotificationKind =
  | 'post_like'
  | 'comment_like'
  | 'post_comment'
  | 'comment_reply'
  | 'follow'
  | 'document_like'
  | 'rating_received'
  | 'badge_awarded'
  | 'collection_share'
  | 'moderation'
  | 'system';

export interface NotifyInput {
  recipientUserId: string;
  actorUserId: string | null;
  kind: NotificationKind;
  targetType?: 'document' | 'post' | 'comment' | 'user' | 'collection' | null;
  targetId?: string | null;
  /**
   * Collapse key. `'post_like:<postId>'` turns a thousand likes into one row.
   * Omit for events that should never collapse — a moderation decision is
   * distinct each time.
   */
  groupKey?: string | null;
  /** Actor name and avatar only. NEVER a snapshot of the target's title. */
  payload?: Record<string, unknown>;
}

/**
 * Create or aggregate a notification.
 *
 * Runs inside the caller's transaction so a notification cannot exist for an
 * event that was rolled back — and cannot be lost for one that committed.
 */
export async function notify(tx: Tx, input: NotifyInput): Promise<void> {
  // Nobody needs telling about their own action.
  if (input.actorUserId && input.actorUserId === input.recipientUserId) return;

  const groupKey = input.groupKey ?? `once:${input.kind}:${input.targetId ?? 'none'}`;

  const inserted = await tx
    .insert(notifications)
    .values({
      recipientUserId: input.recipientUserId,
      actorUserId: input.actorUserId,
      kind: input.kind,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      groupKey,
      payload: input.payload ?? {},
    })
    // The partial unique makes this the aggregation path: a second like on the
    // same post updates the existing unread row rather than adding another.
    .onConflictDoNothing()
    .returning({ id: notifications.id });

  if (inserted.length > 0) {
    // The badge is a column, not a count(*). The client polls it every 30-60
    // seconds; counting rows on a timer is a scan of a table that only grows.
    await adjustCounter(tx, { table: 'users', column: 'unread_notification_count' }, input.recipientUserId, 1);
    return;
  }

  // Conflict: an unread row for this group already exists. Bump its count and
  // refresh the actor shown, so "A thích" becomes "A và 3 người khác thích".
  await tx
    .update(notifications)
    .set({
      aggregationCount: sql`${notifications.aggregationCount} + 1`,
      actorUserId: input.actorUserId,
      payload: input.payload ?? {},
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(notifications.recipientUserId, input.recipientUserId),
        eq(notifications.groupKey, groupKey),
        isNull(notifications.readAt),
        isNull(notifications.deletedAt),
      ),
    );
}

/**
 * Withdraw an unread notification that is no longer true.
 *
 * The case that forced this: A follows B, then unfollows. The "A followed you"
 * notification stays in B's list announcing something that is no longer the
 * case — and if A follows again, the collapse key matches and the row comes
 * back reading "2", which was never a real count of anything.
 *
 * Only UNREAD rows are withdrawn. Once somebody has seen it, it happened —
 * quietly deleting a notification they already read would make the history
 * inconsistent with itself.
 *
 * Returns true when something was withdrawn, so the caller knows the row is
 * gone rather than merely hidden.
 */
export async function retractUnread(
  tx: Tx,
  recipientUserId: string,
  groupKey: string,
): Promise<boolean> {
  const withdrawn = await tx
    .update(notifications)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(notifications.recipientUserId, recipientUserId),
        eq(notifications.groupKey, groupKey),
        isNull(notifications.readAt),
        isNull(notifications.deletedAt),
      ),
    )
    .returning({ id: notifications.id });

  if (withdrawn.length > 0) {
    await adjustCounter(
      tx,
      { table: 'users', column: 'unread_notification_count' },
      recipientUserId,
      -withdrawn.length,
    );
    return true;
  }

  return false;
}

/** Unread count, read from the denormalised column. O(1). */
export async function unreadCount(userId: string): Promise<number> {
  const [row] = await db
    .select({ value: users.unreadNotificationCount })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return Number(row?.value ?? 0);
}

/**
 * Mark every unread notification read, and zero the badge.
 *
 * The `read_at IS NULL` predicate on the update means a notification that
 * arrived while the request was in flight stays unread — marking it read would
 * silently swallow something the user never saw.
 */
export async function markAllRead(tx: Tx, userId: string): Promise<number> {
  const updated = await tx
    .update(notifications)
    .set({ readAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(notifications.recipientUserId, userId),
        isNull(notifications.readAt),
        isNull(notifications.deletedAt),
      ),
    )
    .returning({ id: notifications.id });

  if (updated.length > 0) {
    await adjustCounter(
      tx,
      { table: 'users', column: 'unread_notification_count' },
      userId,
      -updated.length,
    );
  }

  return updated.length;
}

/** Recompute the badge from source rows. Used to self-heal drift. */
export async function reconcileUnread(userId: string): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(notifications)
    .where(
      and(
        eq(notifications.recipientUserId, userId),
        isNull(notifications.readAt),
        isNull(notifications.deletedAt),
      ),
    );

  const actual = Number(row?.value ?? 0);
  await db
    .update(users)
    .set({ unreadNotificationCount: actual })
    .where(eq(users.id, userId));

  return actual;
}
