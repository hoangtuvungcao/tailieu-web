import type { FastifyReply, FastifyRequest } from 'fastify';

import { AppError } from '../../lib/errors.js';
import { paginationMeta } from '../../lib/pagination.js';
import { parseBody, parseParams, parseQuery } from '../../lib/validation.js';
import { getUserPermissions } from '../rbac/rbac.service.js';
import { listSettings, setSetting } from '../settings/settings.service.js';
import * as service from './admin.service.js';
import {
  auditQuerySchema,
  grantRoleSchema,
  reportIdParamSchema,
  reportListQuerySchema,
  resolveReportSchema,
  sessionParamSchema,
  timeseriesQuerySchema,
  updateSettingsSchema,
  updateUserSchema,
  userIdParamSchema,
  userListQuerySchema,
} from './admin.schema.js';

/**
 * Admin HTTP layer.
 *
 * The actor context requires a second permission lookup. It looks redundant
 * given `authorize()` already resolved the permission set, but the request
 * object does not carry it forward — and re-resolving hits the Redis cache, so
 * it is one in-memory read rather than a query.
 */

async function actorOf(request: FastifyRequest): Promise<service.AdminActor> {
  if (!request.user) {
    throw new AppError('UNAUTHORIZED', 'Authentication is required for this request.');
  }

  return {
    userId: request.user.id,
    permissions: request.permissions ?? (await getUserPermissions(request.user.id)),
    ip: request.ip ?? null,
    userAgent: request.headers['user-agent'] ?? null,
    requestId: request.id,
  };
}

function sendPaginated<T>(
  reply: FastifyReply,
  result: { items: T[]; page: number; limit: number; total: number; totalPages: number },
) {
  return reply.ok(result.items, paginationMeta(result));
}

// --- Dashboard ---------------------------------------------------------------

export async function stats(_request: FastifyRequest, reply: FastifyReply) {
  return reply.ok(await service.getStats());
}

export async function timeseries(request: FastifyRequest, reply: FastifyReply) {
  const query = parseQuery(timeseriesQuerySchema, request.query);
  return reply.ok(await service.getTimeseries(query.metric, query.days), {
    metric: query.metric,
    days: query.days,
  });
}

// --- Users -------------------------------------------------------------------

export async function listUsers(request: FastifyRequest, reply: FastifyReply) {
  const query = parseQuery(userListQuerySchema, request.query);
  return sendPaginated(
    reply,
    await service.listUsers(
      { q: query.q, status: query.status, role: query.role, facultyId: query.facultyId },
      query,
    ),
  );
}

export async function getUser(request: FastifyRequest, reply: FastifyReply) {
  const { id } = parseParams(userIdParamSchema, request.params);
  return reply.ok(await service.getUserDetail(id));
}

export async function updateUser(request: FastifyRequest, reply: FastifyReply) {
  const actor = await actorOf(request);
  const { id } = parseParams(userIdParamSchema, request.params);
  const body = parseBody(updateUserSchema, request.body);
  const { reason: _reason, ...changes } = body;

  await service.updateUser(actor, id, changes);
  return reply.ok({ updated: true }, {}, 'Đã cập nhật người dùng.');
}

export async function grantRole(request: FastifyRequest, reply: FastifyReply) {
  const actor = await actorOf(request);
  const { id } = parseParams(userIdParamSchema, request.params);
  const body = parseBody(grantRoleSchema, request.body);

  await service.grantRole(actor, id, body.roleKey, body.facultyId);
  return reply.ok({ granted: true }, {}, 'Đã cấp vai trò.');
}

export async function revokeRole(request: FastifyRequest, reply: FastifyReply) {
  const actor = await actorOf(request);
  const { id, roleId } = parseParams(
    userIdParamSchema.extend({ roleId: userIdParamSchema.shape.id }),
    request.params,
  );

  await service.revokeRole(actor, id, roleId);
  return reply.ok({ revoked: true }, {}, 'Đã thu hồi vai trò.');
}

export async function forceLogout(request: FastifyRequest, reply: FastifyReply) {
  const actor = await actorOf(request);
  const { id } = parseParams(userIdParamSchema, request.params);

  const revoked = await service.forceLogout(actor, id);
  return reply.ok({ sessionsRevoked: revoked }, {}, `Đã đăng xuất ${revoked} phiên.`);
}

export async function listSessions(request: FastifyRequest, reply: FastifyReply) {
  const { id } = parseParams(userIdParamSchema, request.params);
  return reply.ok(await service.getUserSessions(id));
}

export async function revokeSession(request: FastifyRequest, reply: FastifyReply) {
  const actor = await actorOf(request);
  const { id, sessionId } = parseParams(sessionParamSchema, request.params);

  await service.revokeUserSession(actor, id, sessionId);
  return reply.ok({ revoked: true }, {}, 'Đã thu hồi phiên.');
}

export async function listRoles(_request: FastifyRequest, reply: FastifyReply) {
  return reply.ok(await service.listRoles());
}

// --- Audit -------------------------------------------------------------------

export async function listAuditLogs(request: FastifyRequest, reply: FastifyReply) {
  const query = parseQuery(auditQuerySchema, request.query);
  return sendPaginated(
    reply,
    await service.listAuditLogs(
      {
        actorUserId: query.actorUserId,
        action: query.action,
        targetType: query.targetType,
        targetId: query.targetId,
        since: query.since,
      },
      query,
    ),
  );
}

// --- Storage -----------------------------------------------------------------

export async function storage(_request: FastifyRequest, reply: FastifyReply) {
  return reply.ok(await service.getStorageOverview());
}

// --- Reports -----------------------------------------------------------------

export async function listReports(request: FastifyRequest, reply: FastifyReply) {
  const query = parseQuery(reportListQuerySchema, request.query);
  return sendPaginated(
    reply,
    await service.listReports({ status: query.status, targetType: query.targetType }, query),
  );
}

export async function resolveReport(request: FastifyRequest, reply: FastifyReply) {
  const actor = await actorOf(request);
  const { id } = parseParams(reportIdParamSchema, request.params);
  const body = parseBody(resolveReportSchema, request.body);

  await service.resolveReport(actor, id, body.status, body.note);
  return reply.ok({ resolved: true }, {}, 'Đã xử lý báo cáo.');
}

// --- Settings ----------------------------------------------------------------

export async function getSettings(_request: FastifyRequest, reply: FastifyReply) {
  const entries = await listSettings();

  // Grouped for the UI. The API could return a flat list and let the client
  // group, but the categories are a property of the settings themselves, and
  // every client would otherwise reimplement the same grouping.
  const grouped: Record<string, unknown[]> = {};
  for (const entry of entries) {
    (grouped[entry.category] ??= []).push(entry);
  }

  return reply.ok({ entries, grouped });
}

export async function updateSettings(request: FastifyRequest, reply: FastifyReply) {
  const actor = await actorOf(request);
  const body = parseBody(updateSettingsSchema, request.body);

  const keys = Object.keys(body.values);
  for (const key of keys) {
    await setSetting(key, body.values[key], actor.userId);
  }

  return reply.ok({ updated: keys }, {}, `Đã lưu ${keys.length} cài đặt.`);
}
