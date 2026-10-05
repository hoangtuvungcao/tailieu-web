import type { FastifyInstance } from 'fastify';

import { env, isProduction } from '../../config/env.js';
import { pingDatabase } from '../../db/client.js';
import { pingRedis } from '../../db/redis.js';
import { getStorage } from '../../lib/storage/index.js';

/**
 * Health endpoints.
 *
 * Split by audience, and the split is a security boundary rather than a
 * convenience:
 *
 *   GET /api/health          public liveness. No dependencies touched, so it
 *                            always answers 200 while the process is alive —
 *                            which is what a container restart policy needs.
 *                            A database blip must not trigger a restart loop.
 *                            The brief requires this URL to answer publicly.
 *
 *   GET /api/health/db       admin-only. Reports per-dependency status.
 *   GET /api/health/redis    Anonymous access to these is reconnaissance: an
 *   GET /api/health/storage  attacker learning "storage is down" or "redis is
 *                            unreachable" is being handed a timing and
 *                            targeting signal for free.
 *
 * In production the detail endpoints require an authenticated admin. In
 * development they are open, because requiring a login to debug a broken
 * login is a miserable loop.
 */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  const startedAt = Date.now();

  /** Public. Cheap, dependency-free, always 200 while the process lives. */
  app.get('/', async (_request, reply) => {
    return reply.ok({
      status: 'ok',
      service: 'tailieu-ttn-api',
      version: process.env.npm_package_version ?? '0.1.0',
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      timestamp: new Date().toISOString(),
    });
  });

  /**
   * Guard for the detail endpoints.
   *
   * Returns a boolean rather than throwing so the response shape stays
   * identical to the public one — an anonymous caller cannot distinguish
   * "denied" from "healthy", which is the point.
   */
  async function requireAdminOrDev(
    request: Parameters<typeof app.optionalAuth>[0],
    reply: Parameters<typeof app.optionalAuth>[1],
  ): Promise<boolean> {
    if (!isProduction) return true;

    await app.optionalAuth(request, reply);
    if (!request.user) return false;

    const { getUserPermissions } = await import('../rbac/rbac.service.js');
    const permissions = await getUserPermissions(request.user.id);
    return permissions.has('superadmin.all') || permissions.has('analytics.read');
  }

  app.get('/db', async (request, reply) => {
    if (!(await requireAdminOrDev(request, reply))) {
      return reply.fail('FORBIDDEN', 'Not available.');
    }

    try {
      const result = await pingDatabase();
      return reply.ok({ status: 'ok', latencyMs: result.latencyMs });
    } catch (error) {
      request.log.error({ err: error }, 'database health check failed');
      // The error message is deliberately not returned: it routinely contains
      // a hostname, a port, and sometimes a username.
      return reply.status(503).send({
        success: false,
        error: { code: 'SERVICE_UNAVAILABLE', message: 'Database is unavailable.' },
      });
    }
  });

  app.get('/redis', async (request, reply) => {
    if (!(await requireAdminOrDev(request, reply))) {
      return reply.fail('FORBIDDEN', 'Not available.');
    }

    try {
      const result = await pingRedis();
      return reply.ok({ status: 'ok', latencyMs: result.latencyMs });
    } catch (error) {
      request.log.error({ err: error }, 'redis health check failed');
      return reply.status(503).send({
        success: false,
        error: { code: 'SERVICE_UNAVAILABLE', message: 'Redis is unavailable.' },
      });
    }
  });

  app.get('/storage', async (request, reply) => {
    if (!(await requireAdminOrDev(request, reply))) {
      return reply.fail('FORBIDDEN', 'Not available.');
    }

    const health = await getStorage().healthCheck();

    if (!health.ok) {
      request.log.error({ error: health.error }, 'storage health check failed');
      return reply.status(503).send({
        success: false,
        error: {
          code: 'STORAGE_UNAVAILABLE',
          message: 'Object storage is unavailable.',
        },
      });
    }

    return reply.ok({
      status: 'ok',
      latencyMs: health.latencyMs,
      bucket: env.S3_BUCKET,
    });
  });
}
