import type { FastifyInstance } from 'fastify';

import { adminRoutes } from '../modules/admin/admin.route.js';
import { authRoutes } from '../modules/auth/auth.route.js';
import { healthRoutes } from '../modules/health/health.route.js';
import { mediaRoutes } from '../modules/media/media.route.js';
import { searchRoutes } from '../modules/search/search.route.js';
import { bookmarkRoutes } from '../modules/social/bookmarks/bookmarks.route.js';
import { collectionRoutes } from '../modules/social/collections/collections.route.js';
import { commentRoutes } from '../modules/social/comments/comments.route.js';
import { feedRoutes } from '../modules/social/feed/feed.route.js';
import { followRoutes } from '../modules/social/follows/follows.route.js';
import { leaderboardRoutes } from '../modules/social/leaderboards/leaderboards.route.js';
import { likeRoutes } from '../modules/social/likes/likes.route.js';
import { notificationRoutes } from '../modules/social/notifications/notifications.route.js';
import { postRoutes } from '../modules/social/posts/posts.route.js';
import { taxonomyRoutes } from '../modules/taxonomy/taxonomy.route.js';
import { userRoutes } from '../modules/users/users.route.js';
import { documentRoutes } from '../modules/documents/documents.route.js';
import { uploadRoutes } from '../modules/uploads/upload.route.js';

/**
 * Route registration.
 *
 * Two mount points, and the difference is deliberate:
 *
 *   /api/health      Health checks live OUTSIDE the version prefix. The brief
 *                    requires `https://tailieu.5125121.com/api/health` to
 *                    answer, and more practically, an uptime monitor or
 *                    container orchestrator should not need updating when the
 *                    API version changes.
 *
 *   /api/v1/*        Everything else, versioned from day one so a breaking
 *                    change can ship as /api/v2 while old clients keep working.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await app.register(healthRoutes, { prefix: '/api/health' });

  await app.register(
    async (v1) => {
      v1.register(authRoutes, { prefix: '/auth' });
      v1.register(taxonomyRoutes, { prefix: '/taxonomy' });
      v1.register(documentRoutes, { prefix: '/documents' });
      v1.register(uploadRoutes, { prefix: '/uploads' });
      v1.register(searchRoutes, { prefix: '/search' });
      v1.register(adminRoutes, { prefix: '/admin' });
      v1.register(postRoutes, { prefix: '/posts' });
      v1.register(commentRoutes, { prefix: '/comments' });
      v1.register(likeRoutes, { prefix: '/likes' });
      v1.register(followRoutes, { prefix: '/follows' });
      v1.register(notificationRoutes, { prefix: '/notifications' });
      v1.register(bookmarkRoutes, { prefix: '/bookmarks' });
      v1.register(collectionRoutes, { prefix: '/collections' });
      v1.register(userRoutes, { prefix: '/users' });
      v1.register(leaderboardRoutes, { prefix: '/leaderboards' });
      v1.register(feedRoutes, { prefix: '/feed' });
      // Public profile images. Registered under /api/v1/media and referenced by
      // the paths stored in users.avatar_url and users.cover_url — the two must
      // stay in step, which is why `media.paths.ts` owns both directions.
      v1.register(mediaRoutes, { prefix: '/media' });

      // Remaining feature modules land here as they are built:
    },
    { prefix: '/api/v1' },
  );
}
