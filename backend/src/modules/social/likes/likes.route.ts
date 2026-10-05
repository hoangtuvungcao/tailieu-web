import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { parseBody, parseParams } from '../../../lib/validation.js';
import { uuidSchema } from '../../../lib/validation.js';
import { buildActor, requireActor } from '../shared/actor.js';
import * as service from './likes.service.js';

/**
 * Likes.
 *
 * `PUT` rather than `POST`, and an explicit `{ liked: boolean }` rather than a
 * toggle. The reason is retry safety: a toggle is ambiguous — a request that
 * succeeded but whose response was lost gets replayed and undoes itself, so the
 * user clicks once and ends up unliked. Stating the desired state makes the
 * operation idempotent, and `PUT` is the verb that means "make it so".
 */

const targetParams = z.object({
  target: z.enum(['document', 'post', 'comment']),
  id: uuidSchema,
});

const setLikeBody = z.object({ liked: z.boolean() }).strict();

export async function likeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/:target/:id', { preHandler: [app.optionalAuth] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = await buildActor(request);
    const params = parseParams(targetParams, request.params);
    return reply.ok(await service.getLikeState(params.target, params.id, actor));
  });

  app.put(
    '/:target/:id',
    {
      preHandler: [app.authenticate],
      config: {
        rateLimit: {
          // Generous: liking is a one-click action people do in bursts. This
          // bounds a script, not a reader.
          max: 600,
          timeWindow: '1 hour',
          keyGenerator: (request) => `like:${request.user?.id ?? request.ip}`,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = await requireActor(request);
      const params = parseParams(targetParams, request.params);
      const body = parseBody(setLikeBody, request.body);

      const result = await service.setLike(params.target, params.id, body.liked, actor);
      return reply.ok(result);
    },
  );
}
