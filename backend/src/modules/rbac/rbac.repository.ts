import { and, eq, gt, isNull, sql } from 'drizzle-orm';

import { db } from '../../db/client.js';
import { permissions, rolePermissions, roles, sessions, userRoles, users } from '../../db/schema/index.js';

/**
 * RBAC data access.
 *
 * One rule governs this file: scoping is applied in SQL, never by filtering
 * results in JavaScript. A faculty moderator must not be able to reach another
 * faculty's rows at all — if the repository returns them and a caller forgets
 * to filter, the check silently disappears. Filtering in the WHERE clause means
 * the rows are never loaded, so there is nothing to forget.
 */

export interface ResolvedRole {
  key: string;
  facultyId: string | null;
}

export interface UserAuthRecord {
  id: string;
  email: string;
  displayName: string;
  status: 'active' | 'suspended' | 'deactivated';
  emailVerifiedAt: Date | null;
  tokenVersion: number;
  primaryFacultyId: string | null;
  primaryProgramId: string | null;
}

export async function findUserAuthRecord(userId: string): Promise<UserAuthRecord | null> {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      status: users.status,
      emailVerifiedAt: users.emailVerifiedAt,
      tokenVersion: users.tokenVersion,
      primaryFacultyId: users.primaryFacultyId,
      primaryProgramId: users.primaryProgramId,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Effective permission keys for a user.
 *
 * A user with several roles gets the union. `superadmin.all` short-circuits
 * every check in `authorize()`, so the wildcard holder does not need the
 * expanded list materialised here.
 */
export async function selectPermissionKeys(userId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ key: permissions.key })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .innerJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
    .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
    .where(
      and(
        eq(userRoles.userId, userId),
        // An expired grant stops counting the moment it lapses, without a job.
        sql`(${userRoles.expiresAt} IS NULL OR ${userRoles.expiresAt} > now())`,
      ),
    );

  return rows.map((r) => r.key);
}

/** Role keys and their faculty scope, for rank checks and scope resolution. */
export async function selectUserRoles(userId: string): Promise<ResolvedRole[]> {
  const rows = await db
    .select({ key: roles.key, facultyId: userRoles.facultyId })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(
      and(
        eq(userRoles.userId, userId),
        sql`(${userRoles.expiresAt} IS NULL OR ${userRoles.expiresAt} > now())`,
      ),
    );

  return rows.map((r) => ({ key: r.key, facultyId: r.facultyId }));
}

/**
 * Faculty ids a user may moderate.
 *
 * `global: true` means at least one grant is unscoped (a platform moderator or
 * admin), which covers every faculty. Otherwise the caller may only act within
 * the returned faculty ids — and an EMPTY list means they can moderate nothing,
 * which is the correct default for a scoped role granted with a bad faculty id.
 */
export async function selectModerationScope(
  userId: string,
): Promise<{ global: boolean; facultyIds: string[] }> {
  const rows = await db
    .select({ facultyId: userRoles.facultyId })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(
      and(
        eq(userRoles.userId, userId),
        sql`${roles.key} IN ('moderator', 'admin', 'super_admin')`,
        sql`(${userRoles.expiresAt} IS NULL OR ${userRoles.expiresAt} > now())`,
      ),
    );

  if (rows.some((r) => r.facultyId === null)) {
    return { global: true, facultyIds: [] };
  }

  const scoped = await db
    .select({ facultyId: userRoles.facultyId })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(
      and(
        eq(userRoles.userId, userId),
        eq(roles.key, 'faculty_moderator'),
        sql`(${userRoles.expiresAt} IS NULL OR ${userRoles.expiresAt} > now())`,
      ),
    );

  return {
    global: false,
    facultyIds: [
      ...new Set(
        scoped.map((r) => r.facultyId).filter((id): id is string => id !== null),
      ),
    ],
  };
}

/** True when the session exists, is unrevoked and unexpired. */
export async function isSessionLive(sessionId: string, userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        eq(sessions.id, sessionId),
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, new Date()),
      ),
    )
    .limit(1);

  return rows.length > 0;
}
