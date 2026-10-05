import type { FastifyInstance } from 'fastify';

import { env } from '../../config/env.js';
import * as controller from './admin.controller.js';

/**
 * Admin routes.
 *
 * Every route is gated by a specific permission rather than by "is an admin" —
 * so holding `analytics.read` lets someone see the dashboard and nothing else.
 * The permission is enforced here; the frontend hiding a menu item is cosmetic.
 *
 * Reads are rate-limited generously and writes tightly. An administrator
 * clicking through screens should never hit a limit; a scripted role-granting
 * loop should.
 */
export async function adminRoutes(app: FastifyInstance): Promise<void> {
  const can = (permission: string) => ({
    preHandler: [app.authenticate, app.authorize(permission)],
  });

  const writeLimit = {
    rateLimit: { max: 60, timeWindow: '1 hour', keyGenerator: (r: { user?: { id: string }; ip: string }) => `admin-write:${r.user?.id ?? r.ip}` },
  };

  // --- Dashboard -----------------------------------------------------------
  app.get('/stats', can('analytics.read'), controller.stats);
  app.get('/stats/timeseries', can('analytics.read'), controller.timeseries);

  // --- Users ---------------------------------------------------------------
  app.get('/users', can('users.read'), controller.listUsers);
  app.get('/users/:id', can('users.read'), controller.getUser);
  app.patch('/users/:id', { ...can('users.write'), config: writeLimit }, controller.updateUser);
  app.post('/users/:id/roles', { ...can('users.change_role'), config: writeLimit }, controller.grantRole);
  app.delete('/users/:id/roles/:roleId', { ...can('users.change_role'), config: writeLimit }, controller.revokeRole);
  app.post('/users/:id/force-logout', { ...can('users.force_logout'), config: writeLimit }, controller.forceLogout);
  app.get('/users/:id/sessions', can('users.read_sessions'), controller.listSessions);
  app.delete('/users/:id/sessions/:sessionId', { ...can('users.force_logout'), config: writeLimit }, controller.revokeSession);

  app.get('/roles', can('roles.manage'), controller.listRoles);

  // --- Audit ---------------------------------------------------------------
  app.get('/audit-logs', can('audit.read'), controller.listAuditLogs);

  // --- Storage -------------------------------------------------------------
  app.get('/storage', can('storage.manage'), controller.storage);

  // --- Reports -------------------------------------------------------------
  app.get('/reports', can('reports.read'), controller.listReports);
  app.post('/reports/:id/resolve', { ...can('reports.resolve'), config: writeLimit }, controller.resolveReport);

  // --- Settings ------------------------------------------------------------
  app.get('/settings', can('settings.manage'), controller.getSettings);
  app.patch('/settings', { ...can('settings.manage'), config: writeLimit }, controller.updateSettings);

  void env;
}
