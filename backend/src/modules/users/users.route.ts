import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { parseParams, uuidSchema } from '../../lib/validation.js';
import { buildActor } from '../social/shared/actor.js';
import * as service from './users.service.js';

/**
 * Public profiles.
 *
 * `optionalAuth`, matching posts and documents: a signed-out visitor can read a
 * profile, and signing in only adds the follow state and changes which posts
 * and documents get counted.
 *
 * There is no write route here. Everything a user can change about themselves
 * lives on the account endpoints; a profile is a projection of the account, not
 * a second place to edit it.
 */
const userParams = z.object({ id: uuidSchema });

export async function userRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/:id',
    { preHandler: [app.optionalAuth] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = await buildActor(request);
      const { id } = parseParams(userParams, request.params);
      return reply.ok(await service.getProfile(id, actor));
    },
  );
}
