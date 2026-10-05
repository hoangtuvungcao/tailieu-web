import type { FastifyInstance } from 'fastify';

import { env } from '../../config/env.js';
import * as controller from './upload.controller.js';

/**
 * Upload routes.
 *
 * All require authentication — an anonymous chunked upload would be free
 * storage for anyone who finds the endpoint. Rate limiting is per user and
 * generous enough for legitimate use: a student uploading a 2GB thesis sends
 * ~256 chunks, and a per-chunk limit tuned too tightly would fail exactly the
 * large uploads chunking exists to support.
 */
export async function uploadRoutes(app: FastifyInstance): Promise<void> {
  const authed = { preHandler: [app.authenticate] };

  app.get('/allowed-types', authed, controller.allowedTypes);
  app.get('/active', authed, controller.listUploads);

  app.post(
    '/',
    {
      preHandler: [app.authenticate, app.authorize('documents.upload')],
      config: {
        rateLimit: {
          max: env.RATE_LIMIT_UPLOAD_PER_HOUR,
          timeWindow: '1 hour',
          // Keyed on the user, so a shared campus NAT address does not make one
          // student's uploads consume everyone else's budget.
          keyGenerator: (request) => `upload:${request.user?.id ?? request.ip}`,
        },
      },
    },
    controller.createUpload,
  );

  app.get('/:id', authed, controller.getUploadStatus);

  app.put(
    '/:id/chunks/:index',
    {
      preHandler: [app.authenticate, app.authorize('documents.upload')],
      config: {
        rateLimit: {
          // Deliberately high: a large file sends many chunks in quick
          // succession, and this limit is a runaway guard, not a usage policy.
          max: 2000,
          timeWindow: '1 hour',
          keyGenerator: (request) => `chunk:${request.user?.id ?? request.ip}`,
        },
      },
    },
    controller.uploadChunk,
  );

  app.post(
    '/:id/complete',
    { preHandler: [app.authenticate, app.authorize('documents.upload')] },
    controller.completeUpload,
  );

  app.delete('/:id', authed, controller.abortUpload);
}
