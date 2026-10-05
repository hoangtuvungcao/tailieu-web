import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { parseQuery } from '../../../lib/validation.js';
import { buildActor } from '../shared/actor.js';
import { feedQuerySchema } from './feed.schema.js';
import * as service from './feed.service.js';

/**
 * Ranked feed tabs.
 *
 * `trending` is public: it is a ranking of public engagement, and a list nobody
 * can see does not motivate anyone.
 *
 * `for-you` requires an actor, and answers 401 without one rather than
 * degrading. Every term in the heuristic needs a viewer — the people they
 * follow, their faculty, what they have already engaged with. Serving an
 * unpersonalised list under that name would be the one thing the label must not
 * do.
 */
export async function feedRoutes(app: FastifyInstance): Promise<void> {
  const optional = { preHandler: [app.optionalAuth] };

  app.get('/trending', optional, async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = await buildActor(request);
    const query = parseQuery(feedQuerySchema, request.query);

    const page = await service.trending(query.limit, actor);
    // `ranking` says which list actually ran. Its absence would make "trending"
    // a claim the server cannot back when Redis was down.
    return reply.ok(page.posts, { limit: query.limit, ranking: page.ranking });
  });

  app.get(
    '/for-you',
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = await buildActor(request);
      const query = parseQuery(feedQuerySchema, request.query);

      const page = await service.forYou(query.limit, actor);
      return reply.ok(page.posts, {
        limit: query.limit,
        ranking: page.ranking,
        // Said in the response as well as the UI. Any client rendering this
        // should be able to know it is a heuristic without reading the source.
        note: 'heuristic: follows + faculty + trending, ranked by a fixed score',
      });
    },
  );
}
