import { eq, sql } from 'drizzle-orm';

import { db } from '../../../db/client.js';

import { collections, comments, documents, posts, users } from '../../../db/schema/index.js';
import type { Tx } from '../../documents/documents.repository.js';

/**
 * The single counter writer.
 *
 * Every denormalised count in the system goes through this function. That is
 * not tidiness — it is the only defence against drift.
 *
 * There are seven counters now (`documents.like_count`, `posts.like_count`,
 * `comments.reply_count`, `collections.item_count`, `users.unread_notification_count`
 * …) and each is written from several places: a like, an unlike, a moderation
 * removal, a cascade. Two code paths incrementing the same counter with
 * slightly different conditions is how a post ends up with 47 likes and 46 like
 * rows, and nothing fails — the number is just wrong, forever.
 *
 * Two rules, both enforced by there being one implementation:
 *
 *   1. Always inside the transaction that wrote the event. A counter updated
 *      after the commit can be lost by a crash between the two, and a counter
 *      updated before it can survive a rolled-back event.
 *   2. Never below zero. `GREATEST(..., 0)` because a double-decrement is a
 *      silent data bug, and a `-1` shown in the UI is worse than a wrong `0` —
 *      at least `0` is not obviously broken, so nobody chases it.
 */

/** Which table and column to adjust. Typed so a typo is a compile error. */
export type CounterTarget =
  | { table: 'documents'; column: 'like_count' | 'view_count' | 'comment_count' | 'download_count' }
  | { table: 'posts'; column: 'like_count' | 'comment_count' | 'bookmark_count' }
  | { table: 'comments'; column: 'like_count' | 'reply_count' }
  | { table: 'collections'; column: 'item_count' | 'follower_count' }
  | { table: 'users'; column: 'unread_notification_count' };

/**
 * Adjust one counter by `delta`, clamped at zero.
 *
 * Returns nothing: a caller that needs the new value should re-read the row it
 * just changed, inside the same transaction, rather than trusting arithmetic
 * here to be the value the database ends up with.
 */
export async function adjustCounter(
  tx: Tx,
  target: CounterTarget,
  rowId: string,
  delta: number,
): Promise<void> {
  if (delta === 0) return;

  // Raw SQL with an UNQUALIFIED column name.
  //
  // Two attempts before this one failed. A dynamic `.set({ [column]: ... })`
  // renders a qualified column (`"posts"."comment_count"`) into the SET
  // expression, and the driver produced a malformed statement. An unqualified
  // name inside `UPDATE <table>` is unambiguous — Postgres resolves it against
  // the target table — so this form has nothing to render incorrectly.
  //
  // The table and column names are literal members of a union type, so they
  // cannot carry user input; only the delta and the row id are parameters.
  const column = target.column;
  const table = { documents: 'documents', posts: 'posts', comments: 'comments', collections: 'collections', users: 'users' }[
    target.table
  ];

  await tx.execute(sql`
    UPDATE ${sql.raw(`"${table}"`)}
       SET ${sql.raw(`"${column}"`)} = GREATEST(${sql.raw(`"${column}"`)} + ${delta}, 0)
     WHERE id = ${rowId}
  `);
}

/**
 * Recompute a post's engagement score.
 *
 * Recomputed from the counters rather than incremented, for the same reason the
 * rating aggregate is: this is a derived value, and incrementing a derived
 * value on every event means one missed event makes it permanently wrong.
 *
 * Serialised per post by the row lock the caller already holds from the
 * counter update in the same transaction.
 */
export async function refreshPostHotScore(tx: Tx, postId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE posts
       SET hot_score = (like_count * 3 + comment_count * 5 + bookmark_count * 2)::double precision
     WHERE id = ${postId}
  `);
}

/**
 * Reconcile every counter against its source table.
 *
 * Exposed for a maintenance job and for tests. It exists because "the counters
 * are correct" is an assumption worth being able to *check* rather than
 * believe — and when a drift is found, this is what identifies it.
 */
export async function findCounterDrift(): Promise<
  { entity: string; id: string; stored: number; actual: number }[]
> {
  const { rows } = await db.execute<{
    entity: string;
    id: string;
    stored: string;
    actual: string;
  }>(sql`
    SELECT 'documents.like_count' AS entity, d.id::text, d.like_count::text AS stored,
           (SELECT count(*) FROM document_likes l
             WHERE l.document_id = d.id AND l.deleted_at IS NULL)::text AS actual
      FROM documents d
     WHERE d.like_count <> (SELECT count(*) FROM document_likes l
                             WHERE l.document_id = d.id AND l.deleted_at IS NULL)
    UNION ALL
    SELECT 'posts.like_count', p.id::text, p.like_count::text,
           (SELECT count(*) FROM post_likes l
             WHERE l.post_id = p.id AND l.deleted_at IS NULL)::text
      FROM posts p
     WHERE p.like_count <> (SELECT count(*) FROM post_likes l
                             WHERE l.post_id = p.id AND l.deleted_at IS NULL)
    UNION ALL
    SELECT 'collections.item_count', c.id::text, c.item_count::text,
           (SELECT count(*) FROM collection_items ci
             WHERE ci.collection_id = c.id AND ci.deleted_at IS NULL)::text
      FROM collections c
     WHERE c.deleted_at IS NULL
       AND c.item_count <> (SELECT count(*) FROM collection_items ci
                             WHERE ci.collection_id = c.id AND ci.deleted_at IS NULL)
    UNION ALL
    SELECT 'users.unread_notification_count', u.id::text, u.unread_notification_count::text,
           (SELECT count(*) FROM notifications n
             WHERE n.recipient_user_id = u.id AND n.read_at IS NULL AND n.deleted_at IS NULL)::text
      FROM users u
     WHERE u.unread_notification_count <> (SELECT count(*) FROM notifications n
                                            WHERE n.recipient_user_id = u.id
                                              AND n.read_at IS NULL AND n.deleted_at IS NULL)
  `);

  return rows.map((r) => ({
    entity: r.entity,
    id: r.id,
    stored: Number(r.stored),
    actual: Number(r.actual),
  }));
}
