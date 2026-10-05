import type { FastifyInstance } from 'fastify';

import * as controller from './comments.controller.js';

/**
 * Comment routes.
 *
 * Reading is `optionalAuth` — the service checks the *target's* visibility, so
 * a comment on a public post is readable by a visitor while a comment on a
 * private document is not readable by anyone who cannot read that document.
 *
 * The write limiter is tighter than posts': a comment is a much faster action
 * to repeat, so it is the easier one to flood.
 */
export async function commentRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', { preHandler: [app.optionalAuth] }, controller.listComments);

  app.post(
    '/',
    {
      preHandler: [app.authenticate, app.authorize('comments.create')],
      config: {
        rateLimit: {
          max: 60,
          timeWindow: '1 hour',
          keyGenerator: (request) => `comment:${request.user?.id ?? request.ip}`,
        },
      },
    },
    controller.createComment,
  );

  app.patch('/:id', { preHandler: [app.authenticate] }, controller.updateComment);
  app.delete('/:id', { preHandler: [app.authenticate] }, controller.deleteComment);
}
