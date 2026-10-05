import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { paginationSchema } from '../../../lib/pagination.js';
import { parseBody, parseParams, parseQuery } from '../../../lib/validation.js';
import { uuidSchema } from '../../../lib/validation.js';
import { buildActor, requireActor } from '../shared/actor.js';
import * as service from './bookmarks.service.js';

/**
 * Bookmarks.
 *
 * `PUT { bookmarked: boolean }` rather than a toggle, matching likes and
 * follows — an explicit desired state survives a retried request.
 *
 * The list is authenticated only: bookmarks are private, and there is no case
 * where an anonymous caller should see someone else's saved items.
 */
const targetParams = z.object({
  target: z.enum(['document', 'post', 'collection']),
  id: uuidSchema,
});

const setBookmarkBody = z
  .object({
    bookmarked: z.boolean(),
    // `undefined` and `null` are different requests, and collapsing them (the
    // obvious `.nullish().transform(v => v ?? null)`) makes a folder impossible
    // to remove once set: every "leave it alone" and every "take it out" arrived
    // as the same value. Omitted keeps the folder; null clears it.
    folder: z.string().trim().max(60).nullable().optional(),
  })
  .strict();

const listQuery = paginationSchema.extend({
  folder: z.string().trim().max(60).optional(),
});

export async function bookmarkRoutes(app: FastifyInstance): Promise<void> {
  const authed = { preHandler: [app.authenticate] };

  app.get('/', authed, async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = await requireActor(request);
    const query = parseQuery(listQuery, request.query);
    const result = await service.listBookmarks(query, query.folder, actor);
    return reply.ok(result.items, {
      page: result.page,
      limit: result.limit,
      total: result.total,
      totalPages: result.totalPages,
    });
  });

  app.get('/folders', authed, async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = await requireActor(request);
    return reply.ok(await service.listFolders(actor));
  });

  app.get('/:target/:id', { preHandler: [app.optionalAuth] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = await buildActor(request);
    const params = parseParams(targetParams, request.params);
    return reply.ok(await service.getBookmarkState(params.target, params.id, actor));
  });

  app.put(
    '/:target/:id',
    {
      preHandler: [app.authenticate],
      config: {
        rateLimit: {
          max: 600,
          timeWindow: '1 hour',
          keyGenerator: (request) => `bookmark:${request.user?.id ?? request.ip}`,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = await requireActor(request);
      const params = parseParams(targetParams, request.params);
      const body = parseBody(setBookmarkBody, request.body);

      return reply.ok(
        await service.setBookmark(params.target, params.id, body.bookmarked, body.folder, actor),
      );
    },
  );
}
