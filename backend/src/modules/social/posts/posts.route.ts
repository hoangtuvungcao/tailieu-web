import type { FastifyInstance } from 'fastify';

import * as controller from './posts.controller.js';

/**
 * Post routes.
 *
 * Reads use `optionalAuth` so a public post is readable by a visitor; writes
 * require an identity. Creating a post requires `posts.create`, which every
 * signed-in account holds — the setting `posts_enabled` is what turns the
 * feature off, not the permission.
 */
export async function postRoutes(app: FastifyInstance): Promise<void> {
  const optional = { preHandler: [app.optionalAuth] };

  app.get('/', optional, controller.listPosts);
  app.get('/:id', optional, controller.getPost);

  app.post(
    '/',
    {
      preHandler: [app.authenticate, app.authorize('posts.create')],
      config: {
        rateLimit: {
          // Bounds the simplest form of feed flooding. A person posting more
          // than 30 times an hour is not having a conversation.
          max: 30,
          timeWindow: '1 hour',
          keyGenerator: (request) => `post:${request.user?.id ?? request.ip}`,
        },
      },
    },
    controller.createPost,
  );

  app.patch('/:id', { preHandler: [app.authenticate] }, controller.updatePost);
  app.delete('/:id', { preHandler: [app.authenticate] }, controller.deletePost);
}
