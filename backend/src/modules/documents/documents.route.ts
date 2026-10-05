import type { FastifyInstance } from 'fastify';

import { env } from '../../config/env.js';
import * as controller from './documents.controller.js';

/**
 * Document routes.
 *
 * Reads use `optionalAuth`: a public document must be readable by an anonymous
 * visitor, and the service decides what that visitor may see. Writes use
 * `authenticate`.
 *
 * Note the absence of `scope: 'faculty'` on the moderation route. The option
 * only loads the scope onto the request; the actual enforcement happens in
 * `documents.service.ts`, which compares the document's faculty against
 * `viewer.facultyIds` and refuses otherwise. Relying on the preHandler alone
 * would let any faculty moderator moderate every faculty.
 */
export async function documentRoutes(app: FastifyInstance): Promise<void> {
  const optional = { preHandler: [app.optionalAuth] };
  const required = { preHandler: [app.authenticate] };

  // --- Moderation queue -----------------------------------------------------
  // Declared before `/:id` so "queue" is not swallowed as an id.
  app.get('/moderation/queue', required, controller.listModerationQueue);

  // --- Browse and read ------------------------------------------------------
  app.get('/', optional, controller.listDocuments);
  app.get('/tags', optional, controller.listTags);
  app.get('/:id', optional, controller.getDocument);
  app.get('/:id/ratings', optional, controller.listRatings);

  // --- Create and manage ----------------------------------------------------
  app.post(
    '/',
    {
      preHandler: [app.authenticate, app.authorize('documents.upload')],
      config: {
        rateLimit: {
          max: env.RATE_LIMIT_UPLOAD_PER_HOUR,
          timeWindow: '1 hour',
          keyGenerator: (request) => `doccreate:${request.user?.id ?? request.ip}`,
        },
      },
    },
    controller.createDocument,
  );

  app.patch(
    '/:id',
    { preHandler: [app.authenticate, app.authorize('documents.update')] },
    controller.updateDocument,
  );

  app.delete(
    '/:id',
    {
      preHandler: [app.authenticate, app.authorize('documents.delete')],
      config: {
        rateLimit: { max: 60, timeWindow: '1 hour' },
      },
    },
    controller.deleteDocument,
  );

  // --- Download -------------------------------------------------------------
  app.get(
    '/:id/download',
    {
      preHandler: [app.optionalAuth],
      config: {
        rateLimit: {
          max: env.RATE_LIMIT_DOWNLOAD_PER_HOUR,
          timeWindow: '1 hour',
          keyGenerator: (request) => `download:${request.user?.id ?? request.ip}`,
        },
      },
    },
    controller.downloadDocument,
  );

  // --- Preview --------------------------------------------------------------
  app.get('/:id/preview', optional, controller.previewDocument);

  // --- Content --------------------------------------------------------------
  //
  // The bytes themselves, streamed from this origin rather than redirected to
  // the storage host. Authorized by the media token in the query string,
  // because none of the elements that fetch this URL can send a header.
  //
  // Rate-limited by IP rather than by user, since there is no authenticated
  // user here: the token is the identity, and a leaked token being hammered is
  // exactly the case this bounds.
  app.get(
    '/:id/files/:fileId/content',
    {
      config: {
        rateLimit: {
          max: 600,
          timeWindow: '15 minutes',
          keyGenerator: (request) => `content:${request.ip}`,
        },
      },
    },
    controller.streamContent,
  );

  // --- Ratings --------------------------------------------------------------
  app.post(
    '/:id/ratings',
    {
      preHandler: [app.authenticate, app.authorize('documents.rate')],
      config: {
        // Tight: a rating is a considered action, and this bounds the simplest
        // form of rating manipulation.
        rateLimit: {
          max: 30,
          timeWindow: '1 hour',
          keyGenerator: (request) => `rate:${request.user?.id ?? request.ip}`,
        },
      },
    },
    controller.rateDocument,
  );

  app.delete(
    '/:id/ratings',
    { preHandler: [app.authenticate, app.authorize('documents.rate')] },
    controller.removeRating,
  );

  // --- Moderation -----------------------------------------------------------
  app.post(
    '/:id/moderate',
    { preHandler: [app.authenticate, app.authorize('documents.moderate')] },
    controller.moderateDocument,
  );
}
