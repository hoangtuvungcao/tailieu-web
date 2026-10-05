import type { FastifyInstance, FastifyRequest } from 'fastify';

import { AppError } from '../../lib/errors.js';
import { streamObject } from '../../lib/http/stream-object.js';
import { env } from '../../config/env.js';
import { isSafeMediaKey, mediaContentType } from './media.paths.js';

/**
 * Public media.
 *
 * Serves profile avatars and cover images. No authentication: these appear on
 * public profiles, in a document's author line and in a chat client's link
 * preview, so requiring a credential would break every one of those.
 *
 * That is exactly why the route only accepts keys matching the profile-image
 * shape. `media.paths.ts` decides what is safe; this file must not weaken it,
 * because a route that served an arbitrary key would hand out every stored
 * document to anyone who could guess a path.
 *
 * Cached immutably. The filename contains a fresh UUID on every upload, so a
 * changed avatar is a different URL and there is nothing to invalidate — the
 * one cache-header case where `immutable` is not a lie.
 */
export async function mediaRoutes(app: FastifyInstance): Promise<void> {
  app.get('/*', async (request: FastifyRequest, reply) => {
    const key = (request.params as Record<string, string>)['*'] ?? '';

    if (!isSafeMediaKey(key)) {
      // 404 rather than 403: whether a key exists is not information this
      // route should confirm to someone probing paths.
      throw new AppError('MEDIA_NOT_FOUND', 'Không tìm thấy tệp.');
    }

    const contentType = mediaContentType(key);
    if (!contentType) {
      throw new AppError('MEDIA_NOT_FOUND', 'Không tìm thấy tệp.');
    }

    return streamObject(request, reply, {
      location: { bucket: env.S3_BUCKET, key },
      contentType,
      cacheControl: 'public, max-age=31536000, immutable',
    });
  });
}
