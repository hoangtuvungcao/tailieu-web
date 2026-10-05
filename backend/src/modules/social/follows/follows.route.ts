import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { paginationSchema } from '../../../lib/pagination.js';
import { parseBody, parseParams, parseQuery } from '../../../lib/validation.js';
import { uuidSchema } from '../../../lib/validation.js';
import { buildActor, requireActor } from '../shared/actor.js';
import * as service from './follows.service.js';

/**
 * Follow routes.
 *
 * `PUT { following: boolean }` on `/:userId`, mirroring likes: an explicit
 * desired state survives a retried request, where a toggle would undo itself.
 *
 * The list endpoints are public — a follower list is not private information on
 * a community platform, and hiding it would break the "who should I follow"
 * discovery that makes the graph grow.
 */
const userParams = z.object({ userId: uuidSchema });
const setFollowBody = z.object({ following: z.boolean() }).strict();

export async function followRoutes(app: FastifyInstance): Promise<void> {
  const optional = { preHandler: [app.optionalAuth] };

  app.get('/:userId', optional, async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = await buildActor(request);
    const { userId } = parseParams(userParams, request.params);
    return reply.ok(await service.getFollowState(userId, actor));
  });

  app.get('/:userId/following', optional, async (request: FastifyRequest, reply: FastifyReply) => {
    const { userId } = parseParams(userParams, request.params);
    const query = parseQuery(paginationSchema, request.query);
    const result = await service.listFollowing(userId, query);
    return reply.ok(result.items, {
      page: result.page,
      limit: result.limit,
      total: result.total,
      totalPages: result.totalPages,
    });
  });

  app.get('/:userId/followers', optional, async (request: FastifyRequest, reply: FastifyReply) => {
    const { userId } = parseParams(userParams, request.params);
    const query = parseQuery(paginationSchema, request.query);
    const result = await service.listFollowers(userId, query);
    return reply.ok(result.items, {
      page: result.page,
      limit: result.limit,
      total: result.total,
      totalPages: result.totalPages,
    });
  });

  app.put(
    '/:userId',
    {
      preHandler: [app.authenticate],
      config: {
        rateLimit: {
          // Tighter than likes: following is a considered action, and a script
          // mass-following is the first step of a spam campaign.
          max: 200,
          timeWindow: '1 hour',
          keyGenerator: (request) => `follow:${request.user?.id ?? request.ip}`,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = await requireActor(request);
      const { userId } = parseParams(userParams, request.params);
      const body = parseBody(setFollowBody, request.body);
      return reply.ok(await service.setFollow(userId, body.following, actor));
    },
  );
}
