import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { parseQuery } from '../../../lib/validation.js';
import { buildActor } from '../shared/actor.js';
import { leaderboardQuerySchema } from './leaderboards.schema.js';
import * as service from './leaderboards.service.js';

/**
 * Leaderboards.
 *
 * `optionalAuth`, so the board itself is public — a ranking nobody can see does
 * not motivate anyone — and signing in only adds the viewer's own position.
 */
export async function leaderboardRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/',
    { preHandler: [app.optionalAuth] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = await buildActor(request);
      const query = parseQuery(leaderboardQuerySchema, request.query);

      return reply.ok(
        await service.getLeaderboard(
          {
            period: query.period,
            scope: query.scope,
            scopeId: query.scopeId ?? null,
            limit: query.limit,
          },
          actor,
        ),
      );
    },
  );
}
