import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

import { AppError } from '../lib/errors.js';
import { isMaintenanceMode, isReadOnlyMode } from '../modules/settings/settings.service.js';

/**
 * System-state gate.
 *
 * Two switches an administrator can flip during an incident, applied once here
 * rather than checked at each route — a check that has to be remembered is a
 * check that will be forgotten on the next endpoint someone adds.
 *
 *   maintenance_mode  refuse everything except health checks
 *   read_only_mode    refuse every write, allow every read
 *
 * Both are read from the settings cache (30s TTL), so flipping a switch takes
 * effect within seconds without a restart. That is the entire point of putting
 * them in the database rather than the environment.
 */

/**
 * Paths that keep working in maintenance mode.
 *
 * Health checks must answer, or the container's own healthcheck fails and the
 * orchestrator restarts a service that is working exactly as instructed. Auth
 * is reachable so an administrator can sign in to turn maintenance mode *off* —
 * locking everyone out of the switch that unlocks them is a self-inflicted
 * outage.
 */
const MAINTENANCE_ALLOWED = [
  '/api/health',
  '/api/v1/auth/login',
  '/api/v1/auth/refresh',
  '/api/v1/auth/logout',
  '/api/v1/auth/me',
];

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function isAllowedDuringMaintenance(url: string): boolean {
  // Compare on path only; the query string is irrelevant to the decision.
  const path = url.split('?')[0] ?? url;
  return MAINTENANCE_ALLOWED.some((allowed) => path.startsWith(allowed));
}

async function plugin(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (request: FastifyRequest, _reply: FastifyReply) => {
    // Never in tests: a suite that leaves maintenance mode on would make every
    // subsequent test fail for a reason unrelated to what it checks.
    if (process.env.NODE_ENV === 'test') return;

    if (await isMaintenanceMode()) {
      if (isAllowedDuringMaintenance(request.url)) return;

      throw new AppError(
        'MAINTENANCE_MODE',
        'Hệ thống đang bảo trì. Vui lòng thử lại sau ít phút.',
        { retryAfterSeconds: 300 },
      );
    }

    if (READ_METHODS.has(request.method)) return;

    if (await isReadOnlyMode()) {
      throw new AppError(
        'READ_ONLY_MODE',
        'Hệ thống đang ở chế độ chỉ đọc (ví dụ trong lúc sao lưu). Vui lòng thử lại sau.',
        { retryAfterSeconds: 600 },
      );
    }
  });
}

export const systemStatePlugin = fp(plugin, {
  name: 'system-state',
  fastify: '5.x',
});
