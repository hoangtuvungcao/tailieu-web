import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { db } from '../../../db/client.js';
import { comments, notifications, users } from '../../../db/schema/index.js';
import { and, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { paginate, paginationMeta, paginationSchema, toOffset } from '../../../lib/pagination.js';
import { parseParams, parseQuery } from '../../../lib/validation.js';
import { uuidSchema } from '../../../lib/validation.js';
import { requireActor } from '../shared/actor.js';
import { markAllRead, reconcileUnread, unreadCount } from './notifications.service.js';

/**
 * Notification routes.
 *
 * Built for a polling client, which shapes two of these endpoints:
 *
 *   GET /unread-count   — polled every 30-60 seconds by every open tab. Reads
 *                         the denormalised column (a primary-key lookup) and
 *                         answers 304 when nothing changed, so an idle tab
 *                         transfers headers and no body.
 *   GET /               — the list itself, fetched only when the count moves.
 *
 * The payload deliberately carries only actor identity. The target is resolved
 * at read time so a notification cannot show a title the recipient has since
 * lost access to.
 */

const notificationIdParams = z.object({ id: uuidSchema });

export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  const authed = { preHandler: [app.authenticate] };

  /**
   * The polled badge.
   *
   * `ETag` is the count itself, which is all the client needs to decide whether
   * to fetch the list. A 304 on an unchanged count is what keeps an idle tab
   * from pulling a page every minute.
   */
  app.get('/unread-count', authed, async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = await requireActor(request);
    const value = await unreadCount(actor.userId);

    const etag = `W/"unread-${value}"`;
    if (request.headers['if-none-match'] === etag) {
      return reply.status(304).send();
    }

    reply.header('etag', etag);
    // Never cached by a proxy: this is per-user data and a shared cache serving
    // one user's badge to another is exactly the failure to avoid.
    reply.header('cache-control', 'private, no-cache');
    return reply.ok({ unread: value });
  });

  app.get('/', authed, async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = await requireActor(request);
    const query = parseQuery(paginationSchema, request.query);

    const where = and(
      eq(notifications.recipientUserId, actor.userId),
      isNull(notifications.deletedAt),
    )!;

    const [rows, [totalRow]] = await Promise.all([
      db
        .select({
          id: notifications.id,
          kind: notifications.kind,
          targetType: notifications.targetType,
          targetId: notifications.targetId,
          payload: notifications.payload,
          aggregationCount: notifications.aggregationCount,
          readAt: notifications.readAt,
          createdAt: notifications.createdAt,
          actorName: users.displayName,
          actorAvatar: users.avatarUrl,
        })
        .from(notifications)
        // LEFT JOIN: a system notification has no actor, and an INNER join would
        // silently drop every one of them from the list.
        .leftJoin(users, eq(users.id, notifications.actorUserId))
        .where(where)
        .orderBy(desc(notifications.createdAt), desc(notifications.id))
        .limit(query.limit)
        .offset(toOffset(query)),
      db.select({ value: count() }).from(notifications).where(where),
    ]);

    // Self-heal: If notifications target a comment directly, resolve to parent thread (post or document)
    const commentTargetIds = rows
      .filter((r) => r.targetType === 'comment' && r.targetId)
      .map((r) => r.targetId as string);

    const commentParentMap = new Map<string, { targetType: string; targetId: string }>();
    if (commentTargetIds.length > 0) {
      const commentRows = await db
        .select({
          id: comments.id,
          targetType: comments.targetType,
          targetId: comments.targetId,
        })
        .from(comments)
        .where(inArray(comments.id, commentTargetIds));

      for (const c of commentRows) {
        commentParentMap.set(c.id, { targetType: c.targetType, targetId: c.targetId });
      }
    }

    const total = Number(totalRow?.value ?? 0);
    return reply.ok(
      rows.map((row) => {
        let finalTargetType = row.targetType;
        let finalTargetId = row.targetId;

        if (row.targetType === 'comment' && row.targetId) {
          const parent = commentParentMap.get(row.targetId);
          if (parent) {
            finalTargetType = parent.targetType as typeof row.targetType;
            finalTargetId = parent.targetId;
          }
        }

        return {
          ...row,
          targetType: finalTargetType,
          targetId: finalTargetId,
          createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
          readAt: row.readAt === null ? null : row.readAt instanceof Date ? row.readAt.toISOString() : row.readAt,
        };
      }),
      // `paginate` builds the shape `paginationMeta` expects; hand-rolling it
      // produced a mismatch the compiler caught.
      paginationMeta(
        paginate([], total, query),
      ),
    );
  });

  app.post('/read-all', authed, async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = await requireActor(request);
    const marked = await db.transaction(async (tx) => markAllRead(tx, actor.userId));
    return reply.ok({ marked, unread: await unreadCount(actor.userId) }, {}, `Đã đánh dấu ${marked} thông báo.`);
  });

  app.post('/:id/read', authed, async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = await requireActor(request);
    const { id } = parseParams(notificationIdParams, request.params);

    // Scoped to the recipient. Without that predicate any signed-in user could
    // mark somebody else's notifications read by guessing an id — a small but
    // real denial of service.
    const updated = await db
      .update(notifications)
      .set({ readAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(notifications.id, id),
          eq(notifications.recipientUserId, actor.userId),
          isNull(notifications.readAt),
        ),
      )
      .returning({ id: notifications.id });

    if (updated.length > 0) {
      await db.execute(
        // The badge is a column; mark-read decrements it in the same breath as
        // the row changes, so the two cannot disagree.
        sql`
          UPDATE users SET unread_notification_count = GREATEST(unread_notification_count - 1, 0)
           WHERE id = ${actor.userId}
        `,
      );
    }

    return reply.ok({ read: updated.length > 0, unread: await unreadCount(actor.userId) });
  });

  /** Recompute the badge from source rows. Self-heal for any drift. */
  app.post('/reconcile', authed, async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = await requireActor(request);
    const actual = await reconcileUnread(actor.userId);
    return reply.ok({ unread: actual });
  });
}
