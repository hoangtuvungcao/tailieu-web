import { and, eq, sql } from 'drizzle-orm';

import { db } from '../../db/client.js';
import { sessions } from '../../db/schema/index.js';
import { recordAudit } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { paginate, type PaginationInput } from '../../lib/pagination.js';
import { ROLES, rankOf, type RoleKey } from '../../config/permissions.js';
import { invalidatePermissionCaches, markSessionRevoked } from '../rbac/rbac.service.js';
import * as repo from './admin.repository.js';

/**
 * Admin service.
 *
 * Every mutation here runs in a transaction and writes its audit row inside it.
 * These are the actions that change who can do what — granting a role,
 * suspending an account, resolving a report — and "who did this, and when" is
 * the question that gets asked afterwards.
 *
 * The actor's identity is passed in rather than read from a request, so the
 * audit row names a real person and not "system".
 */

export interface AdminActor {
  userId: string;
  permissions: Set<string>;
  ip: string | null;
  userAgent: string | null;
  requestId: string;
}

/**
 * Rank check: an administrator must not be able to act on someone who outranks
 * them. Without this, a moderator could suspend the administrator who is
 * investigating them, and an admin could ban the super admin who owns the
 * platform.
 */
function assertCanActOn(actor: AdminActor, targetRoles: string[]): void {
  if (actor.permissions.has('superadmin.all')) return;

  const actorRank = highest(actor.permissions);
  const targetRank = targetRoles.reduce((max, key) => Math.max(max, rankOfSafe(key)), 0);

  if (targetRank >= actorRank) {
    throw new AppError(
      'INSUFFICIENT_RANK',
      'Bạn không thể tác động lên người dùng có vai trò ngang hoặc cao hơn mình.',
    );
  }
}

function highest(permissions: Set<string>): number {
  // A coarse stand-in for the actor's own rank. The permission set is what the
  // request actually carries; deriving rank from it avoids a second query.
  if (permissions.has('users.change_role')) return 80;
  if (permissions.has('documents.moderate')) return 50;
  return 10;
}

function rankOfSafe(key: string): number {
  return Object.prototype.hasOwnProperty.call(ROLES, key) ? rankOf(key as RoleKey) : 0;
}

// --- Dashboard ---------------------------------------------------------------

export function getStats() {
  return repo.getPlatformStats();
}

export async function getTimeseries(
  metric: repo.TimeseriesMetric,
  days: number,
): Promise<{ date: string; value: number }[]> {
  // Bound the window: a year of daily rows is a chart nobody can read, and an
  // unbounded range is a query an operator can accidentally make expensive.
  const bounded = Math.min(Math.max(days, 7), 365);
  return repo.getTimeseries(metric, bounded);
}

// --- Users -------------------------------------------------------------------

export async function listUsers(filters: repo.UserListFilters, pagination: PaginationInput) {
  const { items, total } = await repo.listUsers(filters, pagination);
  return paginate(
    items.map((u) => ({
      ...u,
      emailVerified: u.emailVerifiedAt !== null,
      lastLoginAt: u.lastLoginAt instanceof Date ? u.lastLoginAt.toISOString() : u.lastLoginAt,
      createdAt: u.createdAt instanceof Date ? u.createdAt.toISOString() : u.createdAt,
    })),
    total,
    pagination,
  );
}

export async function getUserDetail(userId: string) {
  const detail = await repo.getUserDetail(userId);
  if (!detail) throw new AppError('USER_NOT_FOUND', 'Không tìm thấy người dùng.');

  const [sessions, usage] = await Promise.all([
    repo.listUserSessions(userId),
    repo.userUsage(userId),
  ]);

  return { ...detail, sessions, usage };
}

export async function updateUser(
  actor: AdminActor,
  userId: string,
  input: Partial<{
    status: 'active' | 'suspended' | 'deactivated';
    primaryFacultyId: string | null;
    primaryProgramId: string | null;
    displayName: string;
  }>,
): Promise<void> {
  await db.transaction(async (tx) => {
    const detail = await repo.getUserDetail(userId, tx);
    if (!detail) throw new AppError('USER_NOT_FOUND', 'Không tìm thấy người dùng.');

    if (userId === actor.userId && input.status && input.status !== 'active') {
      // Locking yourself out is never what was meant, and recovering needs
      // database access.
      throw new AppError('CANNOT_MODIFY_SELF', 'Bạn không thể tự khoá tài khoản của mình.');
    }

    assertCanActOn(actor, detail.roles.map((r) => r.roleKey));

    await repo.updateUser(tx, userId, input);

    // Suspending or deactivating must end the sessions *now*. Leaving them live
    // until the access token expires means a suspended account keeps working
    // for up to 15 minutes.
    if (input.status && input.status !== 'active') {
      await tx
        .update(sessions)
        .set({ revokedAt: new Date(), revokedReason: 'admin' })
        .where(and(eq(sessions.userId, userId), sql`${sessions.revokedAt} IS NULL`));

      // Bumping the token version is what kills the access token the user is
      // already holding; revoking sessions alone leaves it valid for up to
      // 15 minutes.
      await tx.execute(
        sql`UPDATE users SET token_version = token_version + 1 WHERE id = ${userId}`,
      );
    }

    await recordAudit(tx, {
      action: input.status ? `admin.user.${input.status}` : 'admin.user.updated',
      actorUserId: actor.userId,
      targetType: 'user',
      targetId: userId,
      metadata: {
        before: { status: detail.status, facultyId: detail.primaryFacultyId },
        after: input,
      },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  await invalidatePermissionCaches();
}

export async function grantRole(
  actor: AdminActor,
  userId: string,
  roleKey: string,
  facultyId: string | null,
): Promise<void> {
  const role = await repo.findRoleByKey(roleKey);
  if (!role) throw new AppError('ROLE_NOT_FOUND', `Vai trò "${roleKey}" không tồn tại.`);

  // Privilege escalation guard: `super_admin` is deliberately not grantable
  // through the API. The only way to create one is the seed script or direct
  // database access — so a compromised admin account cannot mint an
  // unremovable one.
  if (roleKey === 'super_admin' && !actor.permissions.has('superadmin.all')) {
    throw new AppError(
      'ROLE_NOT_GRANTABLE',
      'Không thể cấp vai trò quản trị tối cao qua API.',
    );
  }

  // A faculty-scoped role without a scope is a global grant wearing a scoped
  // name — the exact confusion the scope column exists to prevent.
  if (roleKey === 'faculty_moderator' && !facultyId) {
    throw new AppError(
      'FACULTY_SCOPE_REQUIRED',
      'Vai trò kiểm duyệt viên khoa phải được gán kèm một khoa.',
    );
  }

  await db.transaction(async (tx) => {
    const detail = await repo.getUserDetail(userId, tx);
    if (!detail) throw new AppError('USER_NOT_FOUND', 'Không tìm thấy người dùng.');
    assertCanActOn(actor, detail.roles.map((r) => r.roleKey));

    await repo.grantRole(tx, {
      userId,
      roleId: role.id,
      facultyId,
      grantedBy: actor.userId,
    });

    await recordAudit(tx, {
      action: 'admin.role.granted',
      actorUserId: actor.userId,
      targetType: 'user',
      targetId: userId,
      metadata: { roleKey, facultyId },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  // Revocation and granting both change the effective permission set, and the
  // cache must not keep serving the old one.
  await invalidatePermissionCaches();
}

export async function revokeRole(
  actor: AdminActor,
  userId: string,
  roleId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const detail = await repo.getUserDetail(userId, tx);
    if (!detail) throw new AppError('USER_NOT_FOUND', 'Không tìm thấy người dùng.');

    const target = detail.roles.find((r) => r.id === roleId);
    if (!target) {
      throw new AppError('ROLE_NOT_FOUND', 'Người dùng không giữ vai trò này.');
    }

    if (target.roleKey === 'super_admin') {
      throw new AppError('ROLE_NOT_GRANTABLE', 'Không thể thu hồi vai trò quản trị tối cao.');
    }

    // Removing the last administrator leaves the platform unmanageable, and the
    // only fix is direct database access.
    if (target.roleKey === 'admin') {
      const otherAdmins = detail.roles.filter(
        (r) => r.roleKey === 'admin' || r.roleKey === 'super_admin',
      );
      if (otherAdmins.length <= 1) {
        throw new AppError(
          'CONFLICT',
          'Không thể thu hồi quản trị viên cuối cùng — hệ thống sẽ không còn ai quản lý.',
        );
      }
    }

    await repo.revokeRole(tx, userId, roleId);

    await recordAudit(tx, {
      action: 'admin.role.revoked',
      actorUserId: actor.userId,
      targetType: 'user',
      targetId: userId,
      metadata: { roleKey: target.roleKey },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  await invalidatePermissionCaches();
}

export async function forceLogout(actor: AdminActor, userId: string): Promise<number> {
  const count = await db.transaction(async (tx) => {
    const revoked = await tx.execute<{ id: string }>(sql`
      UPDATE sessions SET revoked_at = now(), revoked_reason = 'admin'
       WHERE user_id = ${userId} AND revoked_at IS NULL
      RETURNING id
    `);

    // Bumping the token version is what makes this immediate rather than
    // eventually: without it the user's current access token keeps working for
    // up to 15 minutes after being signed out.
    await tx.execute(sql`
      UPDATE users SET token_version = token_version + 1 WHERE id = ${userId}
    `);

    await recordAudit(tx, {
      action: 'admin.user.force_logout',
      actorUserId: actor.userId,
      targetType: 'user',
      targetId: userId,
      metadata: { sessionsRevoked: revoked.rows.length },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return revoked.rows.length;
  });

  await invalidatePermissionCaches();
  return count;
}

export async function listRoles() {
  return repo.listAllRoles();
}

export async function getUserSessions(userId: string) {
  const sessions = await repo.listUserSessions(userId);
  return sessions.map((s) => ({
    ...s,
    active: s.revokedReason === null,
  }));
}

export async function revokeUserSession(
  actor: AdminActor,
  userId: string,
  sessionId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(sessions)
      .set({ revokedAt: new Date(), revokedReason: 'admin' })
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)));

    await recordAudit(tx, {
      action: 'admin.session.revoked',
      actorUserId: actor.userId,
      targetType: 'session',
      targetId: sessionId,
      metadata: { userId },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  await markSessionRevoked(sessionId);
}

// --- Audit -------------------------------------------------------------------

export async function listAuditLogs(filters: repo.AuditFilters, pagination: PaginationInput) {
  const { items, total } = await repo.listAuditLogs(filters, pagination);
  return paginate(
    items.map((row) => ({
      ...row,
      createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    })),
    total,
    pagination,
  );
}

// --- Storage -----------------------------------------------------------------

export async function getStorageOverview() {
  const [stats, largest, orphaned, liveBytes] = await Promise.all([
    repo.getPlatformStats(),
    repo.listLargestObjects(20),
    repo.listOrphanedObjects(24, 50),
    repo.totalStoredBytes(),
  ]);

  return {
    ...stats.storage,
    /** Bytes actually referenced by live documents, as opposed to stored. */
    liveBytes,
    largest: largest.map((o) => ({
      objectKey: o.objectKey,
      sizeBytes: Number(o.sizeBytes),
      mimeType: o.detectedMime,
      refCount: o.refCount,
    })),
    orphans: orphaned.map((o) => ({
      objectKey: o.objectKey,
      sizeBytes: Number(o.sizeBytes),
      createdAt: o.createdAt instanceof Date ? o.createdAt.toISOString() : o.createdAt,
    })),
  };
}

// --- Reports -----------------------------------------------------------------

export async function listReports(filters: repo.ReportFilters, pagination: PaginationInput) {
  const { items, total } = await repo.listReports(filters, pagination);
  return paginate(
    items.map((r) => ({
      ...r,
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
      resolvedAt: r.resolvedAt instanceof Date ? r.resolvedAt.toISOString() : r.resolvedAt,
    })),
    total,
    pagination,
  );
}

export async function resolveReport(
  actor: AdminActor,
  reportId: string,
  status: 'resolved' | 'rejected' | 'reviewing',
  note: string | null,
): Promise<void> {
  await db.transaction(async (tx) => {
    const report = await repo.findReportById(reportId, tx);
    if (!report) throw new AppError('NOT_FOUND', 'Không tìm thấy báo cáo.');

    if (report.status === 'resolved' || report.status === 'rejected') {
      throw new AppError('CONFLICT', 'Báo cáo này đã được xử lý.');
    }

    await repo.resolveReport(tx, {
      reportId,
      status,
      resolvedByUserId: actor.userId,
      note,
    });

    await recordAudit(tx, {
      action: `admin.report.${status}`,
      actorUserId: actor.userId,
      targetType: report.targetType,
      targetId: report.targetId,
      metadata: { reportId, reason: report.reason, note },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });
}
