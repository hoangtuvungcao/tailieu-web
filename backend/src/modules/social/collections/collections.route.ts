import type { FastifyInstance } from 'fastify';

import * as controller from './collections.controller.js';

/**
 * Collection routes.
 *
 * `/mine` is declared before `/:id` — Fastify's router would otherwise match
 * the literal segment as an id and fail uuid validation with a 422 instead of
 * listing the caller's collections.
 *
 * Reads are `optionalAuth` because a public collection is exactly the kind of
 * thing an anonymous visitor should be able to browse; the service applies the
 * viewer's own predicate to the collection *and* to every item inside it.
 */
export async function collectionRoutes(app: FastifyInstance): Promise<void> {
  const optional = { preHandler: [app.optionalAuth] };
  const required = { preHandler: [app.authenticate] };

  app.get('/', optional, controller.listCollections);
  app.get('/mine', required, controller.listMine);

  app.post(
    '/',
    {
      preHandler: [app.authenticate, app.authorize('collections.create')],
      config: {
        rateLimit: {
          max: 30,
          timeWindow: '1 hour',
          keyGenerator: (request) => `collection:create:${request.user?.id ?? request.ip}`,
        },
      },
    },
    controller.createCollection,
  );

  app.get('/:id', optional, controller.getCollection);
  app.patch('/:id', required, controller.updateCollection);
  app.delete('/:id', required, controller.deleteCollection);

  // --- Items ----------------------------------------------------------------
  // Adding is the abusive verb here: it is how a public collection would be
  // used to launder access to a private document, so it is limited far more
  // tightly than reading.
  app.post(
    '/:id/items',
    {
      preHandler: [app.authenticate],
      config: {
        rateLimit: {
          max: 300,
          timeWindow: '1 hour',
          keyGenerator: (request) => `collection:item:${request.user?.id ?? request.ip}`,
        },
      },
    },
    controller.addItem,
  );

  app.delete('/:id/items/:itemId', required, controller.removeItem);
  app.patch('/:id/items/order', required, controller.reorderItems);
}
