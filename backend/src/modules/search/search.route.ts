import type { FastifyInstance } from 'fastify';

import { env } from '../../config/env.js';
import * as controller from './search.controller.js';

/**
 * Search routes.
 *
 * `/search` uses `optionalAuth`: search results are visibility-filtered rather
 * than login-gated, so an anonymous visitor can find public documents — which
 * is most of what makes the site discoverable. The provider applies the
 * visibility predicate itself, so an anonymous caller cannot receive a private
 * document even by guessing its title.
 *
 * Rate limiting is per identity where known, per IP otherwise. Typeahead fires
 * on nearly every keystroke, so `suggest` gets its own, more generous bucket
 * than `search` — sharing one limit would make typing a query exhaust the
 * budget for submitting it.
 */
export async function searchRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/',
    {
      preHandler: [app.optionalAuth],
      config: {
        rateLimit: {
          max: env.RATE_LIMIT_SEARCH_PER_MIN,
          timeWindow: '1 minute',
          keyGenerator: (request) => `search:${request.user?.id ?? request.ip}`,
        },
      },
    },
    controller.search,
  );

  app.get(
    '/suggest',
    {
      preHandler: [app.optionalAuth],
      config: {
        rateLimit: {
          // Several times the search limit: one typed query is many keystrokes.
          max: env.RATE_LIMIT_SEARCH_PER_MIN * 6,
          timeWindow: '1 minute',
          keyGenerator: (request) => `suggest:${request.user?.id ?? request.ip}`,
        },
      },
    },
    controller.suggest,
  );

  app.get('/info', controller.searchInfo);
  app.get('/health', controller.searchHealth);

  app.post(
    '/reindex',
    {
      preHandler: [app.authenticate, app.authorize('search.reindex')],
    },
    controller.reindex,
  );
}
