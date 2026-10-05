import { and, count, desc, eq, gte, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';

import { db, type Database } from '../../db/client.js';
import {
  auditLogs,
  documentFiles,
  documents,
  reports,
  roles,
  sessions,
  storageObjects,
  storageUsage,
  uploadSessions,
  userRoles,
  users,
} from '../../db/schema/index.js';
import { toOffset, type PaginationInput } from '../../lib/pagination.js';

export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
export type Executor = Tx | typeof db;

/**
 * Admin data access.
 *
 * Every query here is an aggregate or an indexed lookup. That is a deliberate
 * constraint: an admin dashboard is a page an operator opens during an
 * incident, and a dashboard that takes eight seconds to load because it runs
 * five unindexed `count(*)` scans over `download_events` is worse than useless
 * at exactly the moment it is needed.
 *
 * Counters that already exist denormalised on `documents` are used rather than
 * re-derived. `SUM(download_count)` over documents is a small index-only scan
 * of a table with a few thousand rows; `count(*) FROM download_events` is a
 * scan of a table with millions.
 */

// --- Dashboard ---------------------------------------------------------------

export interface PlatformStats {
  users: { total: number; active30d: number; newToday: number; new7d: number; suspended: number };
  documents: {
    total: number;
    published: number;
    pendingReview: number;
    deleted: number;
    downloads: number;
  };
  storage: { objects: number; bytes: number; orphaned: number; shared: number };
  moderation: { openReports: number; pendingDocuments: number };
  uploads: { inProgress: number };
}

/**
 * One round trip per section, run concurrently.
 *
 * Sequential `await`s here would make the dashboard the sum of every query
 * rather than the slowest one — and with ten of them at 20ms each that is
 * 200ms of pure waiting on a page that should feel instant.
 */
export async function getPlatformStats(): Promise<PlatformStats> {
  const dayAgo = new Date(Date.now() - 86_400_000);
  const weekAgo = new Date(Date.now() - 7 * 86_400_000);
  const monthAgo = new Date(Date.now() - 30 * 86_400_000);

  const [
    userRows,
    documentRows,
    storageRows,
    reportRows,
    uploadRows,
  ] = await Promise.all([
    db
      .select({
        total: count(),
        // `FILTER` keeps this to one pass over users rather than three
        // separate queries with different WHERE clauses.
        active30d: sql<number>`count(*) FILTER (WHERE last_login_at >= ${monthAgo})::int`,
        newToday: sql<number>`count(*) FILTER (WHERE created_at >= ${dayAgo})::int`,
        new7d: sql<number>`count(*) FILTER (WHERE created_at >= ${weekAgo})::int`,
        suspended: sql<number>`count(*) FILTER (WHERE status = 'suspended')::int`,
      })
      .from(users)
      .where(isNull(users.anonymizedAt)),

    db
      .select({
        total: count(),
        published: sql<number>`count(*) FILTER (WHERE status = 'published')::int`,
        pendingReview: sql<number>`count(*) FILTER (WHERE status = 'pending_review')::int`,
        deleted: sql<number>`count(*) FILTER (WHERE deleted_at IS NOT NULL)::int`,
        // Summed from the denormalised counter, not from download_events.
        downloads: sql<number>`COALESCE(SUM(download_count), 0)::bigint`,
      })
      .from(documents),

    db
      .select({
        objects: count(),
        bytes: sql<number>`COALESCE(SUM(size_bytes), 0)::bigint`,
        orphaned: sql<number>`count(*) FILTER (WHERE ref_count = 0)::int`,
        shared: sql<number>`count(*) FILTER (WHERE ref_count > 1)::int`,
      })
      .from(storageObjects),

    db
      .select({ open: count() })
      .from(reports)
      .where(and(eq(reports.status, 'pending'), isNull(reports.deletedAt))),

    db
      .select({ inProgress: count() })
      .from(uploadSessions)
      .where(inArray(uploadSessions.status, ['pending', 'assembling'])),
  ]);

  const userRow = userRows[0];
  const documentRow = documentRows[0];
  const storageRow = storageRows[0];

  return {
    users: {
      total: Number(userRow?.total ?? 0),
      active30d: Number(userRow?.active30d ?? 0),
      newToday: Number(userRow?.newToday ?? 0),
      new7d: Number(userRow?.new7d ?? 0),
      suspended: Number(userRow?.suspended ?? 0),
    },
    documents: {
      total: Number(documentRow?.total ?? 0),
      published: Number(documentRow?.published ?? 0),
      pendingReview: Number(documentRow?.pendingReview ?? 0),
      deleted: Number(documentRow?.deleted ?? 0),
      downloads: Number(documentRow?.downloads ?? 0),
    },
    storage: {
      objects: Number(storageRow?.objects ?? 0),
      bytes: Number(storageRow?.bytes ?? 0),
      orphaned: Number(storageRow?.orphaned ?? 0),
      shared: Number(storageRow?.shared ?? 0),
    },
    moderation: {
      openReports: Number(reportRows[0]?.open ?? 0),
      pendingDocuments: Number(documentRow?.pendingReview ?? 0),
    },
    uploads: { inProgress: Number(uploadRows[0]?.inProgress ?? 0) },
  };
}

export type TimeseriesMetric = 'users' | 'documents' | 'downloads' | 'uploads';

/**
 * Daily counts for a chart.
 *
 * `generate_series` produces one row per day whether or not anything happened,
 * so the chart has no gaps. Filling missing days in JavaScript instead would
 * mean a line that skips Tuesday because nobody uploaded, which reads as a
 * rendering bug rather than a quiet day.
 */
export async function getTimeseries(
  metric: TimeseriesMetric,
  days: number,
): Promise<{ date: string; value: number }[]> {
  const source = {
    users: sql`SELECT created_at::date AS day, count(*)::int AS value FROM users WHERE anonymized_at IS NULL GROUP BY 1`,
    documents: sql`SELECT created_at::date AS day, count(*)::int AS value FROM documents WHERE deleted_at IS NULL GROUP BY 1`,
    // Derived from the denormalised per-document total rather than the raw
    // event table: one row per document instead of one per download.
    downloads: sql`SELECT created_at::date AS day, COALESCE(SUM(download_count), 0)::int AS value FROM documents GROUP BY 1`,
    uploads: sql`SELECT created_at::date AS day, count(*)::int AS value FROM upload_sessions GROUP BY 1`,
  }[metric];

  const { rows } = await db.execute<{ day: string; value: number }>(sql`
    WITH series AS (
      SELECT generate_series(
        (now() - ${`${days} days`}::interval)::date,
        now()::date,
        '1 day'::interval
      )::date AS day
    ),
    counts AS (${source})
    SELECT to_char(series.day, 'YYYY-MM-DD') AS day,
           COALESCE(counts.value, 0)::int   AS value
      FROM series
      LEFT JOIN counts ON counts.day = series.day
     ORDER BY series.day
  `);

  return rows.map((r) => ({ date: r.day, value: Number(r.value) }));
}

// --- Users -------------------------------------------------------------------

export interface UserListFilters {
  q?: string;
  status?: 'active' | 'suspended' | 'deactivated';
  role?: string;
  facultyId?: string;
}

export async function listUsers(
  filters: UserListFilters,
  pagination: PaginationInput,
  executor: Executor = db,
) {
  const predicates: SQL[] = [isNull(users.anonymizedAt)];

  if (filters.status) predicates.push(eq(users.status, filters.status));
  if (filters.facultyId) predicates.push(eq(users.primaryFacultyId, filters.facultyId));
  if (filters.q) {
    const pattern = `%${filters.q}%`;
    predicates.push(
      or(
        sql`immutable_unaccent(${users.displayName}) ILIKE immutable_unaccent(${pattern})`,
        sql`${users.email}::text ILIKE ${pattern}`,
      )!,
    );
  }
  if (filters.role) {
    predicates.push(
      sql`EXISTS (
        SELECT 1
          FROM user_roles
          JOIN roles ON roles.id = user_roles.role_id
         WHERE user_roles.user_id = users.id
           AND roles.key = ${filters.role}
      )`,
    );
  }

  const where = and(...predicates)!;

  const [rows, [totalRow]] = await Promise.all([
    executor
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        status: users.status,
        emailVerifiedAt: users.emailVerifiedAt,
        primaryFacultyId: users.primaryFacultyId,
        lastLoginAt: users.lastLoginAt,
        createdAt: users.createdAt,
        // Aggregated in the query rather than one lookup per row, which would
        // be the classic N+1 on a list page.
        // Aggregated in the query rather than one lookup per row, which would
        // be the classic N+1 on a list page. Real table names, not aliases —
        // a bare `id` in here is ambiguous against the outer `users`.
        roleKeys: sql<string[]>`COALESCE(
          ARRAY(
            SELECT roles.key
              FROM user_roles
              JOIN roles ON roles.id = user_roles.role_id
             WHERE user_roles.user_id = users.id
          ), ARRAY[]::text[]
        )`,
      })
      .from(users)
      .where(where)
      .orderBy(desc(users.createdAt))
      .limit(pagination.limit)
      .offset(toOffset(pagination)),
    executor.select({ value: count() }).from(users).where(where),
  ]);

  return { items: rows, total: Number(totalRow?.value ?? 0) };
}

/** A user's full admin view: profile, roles with scope, and session count. */
export async function getUserDetail(userId: string, executor: Executor = db) {
  const [userRow] = await executor
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      fullName: users.fullName,
      status: users.status,
      emailVerifiedAt: users.emailVerifiedAt,
      tokenVersion: users.tokenVersion,
      primaryFacultyId: users.primaryFacultyId,
      primaryProgramId: users.primaryProgramId,
      studentCode: users.studentCode,
      lastLoginAt: users.lastLoginAt,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!userRow) return null;

  const [roleRows, [sessionRow]] = await Promise.all([
    executor
      .select({
        id: userRoles.id,
        roleId: roles.id,
        roleKey: roles.key,
        roleName: roles.name,
        facultyId: userRoles.facultyId,
        grantedAt: userRoles.createdAt,
      })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(eq(userRoles.userId, userId)),
    executor
      .select({ value: count() })
      .from(sessions)
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt))),
  ]);

  return {
    ...userRow,
    roles: roleRows,
    activeSessions: Number(sessionRow?.value ?? 0),
  };
}

export async function updateUser(
  executor: Executor,
  userId: string,
  values: Partial<{
    status: 'active' | 'suspended' | 'deactivated';
    primaryFacultyId: string | null;
    primaryProgramId: string | null;
    displayName: string;
  }>,
): Promise<void> {
  await executor
    .update(users)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(users.id, userId));
}

/**
 * Grant a role, optionally scoped to a faculty.
 *
 * `onConflictDoNothing` against the `NULLS NOT DISTINCT` unique constraint makes
 * this idempotent — granting a role somebody already holds is a no-op rather
 * than a duplicate-key error an administrator cannot act on.
 */
export async function grantRole(
  executor: Executor,
  values: { userId: string; roleId: string; facultyId: string | null; grantedBy: string },
): Promise<void> {
  await executor
    .insert(userRoles)
    .values({
      userId: values.userId,
      roleId: values.roleId,
      facultyId: values.facultyId,
      grantedBy: values.grantedBy,
    })
    .onConflictDoNothing();
}

export async function revokeRole(
  executor: Executor,
  userId: string,
  roleId: string,
): Promise<number> {
  const removed = await executor
    .delete(userRoles)
    .where(and(eq(userRoles.userId, userId), eq(userRoles.roleId, roleId)))
    .returning({ id: userRoles.id });
  return removed.length;
}

export async function findRoleByKey(key: string, executor: Executor = db) {
  const rows = await executor
    .select({ id: roles.id, key: roles.key, name: roles.name, rank: roles.rank })
    .from(roles)
    .where(eq(roles.key, key))
    .limit(1);
  return rows[0] ?? null;
}

export async function listAllRoles(executor: Executor = db) {
  return executor
    .select({ id: roles.id, key: roles.key, name: roles.name, rank: roles.rank })
    .from(roles)
    .orderBy(desc(roles.rank));
}

export async function listUserSessions(userId: string, executor: Executor = db) {
  return executor
    .select({
      id: sessions.id,
      userAgent: sessions.userAgent,
      ip: sessions.ip,
      createdAt: sessions.createdAt,
      lastUsedAt: sessions.lastUsedAt,
      expiresAt: sessions.expiresAt,
      revokedReason: sessions.revokedReason,
    })
    .from(sessions)
    .where(eq(sessions.userId, userId))
    .orderBy(desc(sessions.lastUsedAt))
    .limit(50);
}

export async function userUsage(userId: string, executor: Executor = db) {
  const [row] = await executor
    .select({
      usedBytes: storageUsage.usedBytes,
      documentCount: storageUsage.documentCount,
      quotaBytes: storageUsage.quotaBytes,
    })
    .from(storageUsage)
    .where(eq(storageUsage.userId, userId))
    .limit(1);
  return row ?? { usedBytes: 0, documentCount: 0, quotaBytes: null };
}

// --- Audit log ---------------------------------------------------------------

export interface AuditFilters {
  actorUserId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  since?: string;
}

export async function listAuditLogs(
  filters: AuditFilters,
  pagination: PaginationInput,
  executor: Executor = db,
) {
  const predicates: SQL[] = [];
  if (filters.actorUserId) predicates.push(eq(auditLogs.actorUserId, filters.actorUserId));
  if (filters.action) predicates.push(sql`${auditLogs.action} ILIKE ${'%' + filters.action + '%'}`);
  if (filters.targetType) predicates.push(eq(auditLogs.targetType, filters.targetType));
  if (filters.targetId) predicates.push(eq(auditLogs.targetId, filters.targetId));
  if (filters.since) predicates.push(gte(auditLogs.createdAt, new Date(filters.since)));

  // An empty list must be `true`, not `and()` with no arguments — Drizzle
  // renders the latter as nothing, which silently turns the filter off.
  const where = predicates.length > 0 ? and(...predicates) : sql`true`;

  const [rows, [totalRow]] = await Promise.all([
    executor
      .select({
        id: auditLogs.id,
        action: auditLogs.action,
        actorUserId: auditLogs.actorUserId,
        actorEmail: users.email,
        actorName: users.displayName,
        targetType: auditLogs.targetType,
        targetId: auditLogs.targetId,
        metadata: auditLogs.metadata,
        ip: auditLogs.ip,
        requestId: auditLogs.requestId,
        createdAt: auditLogs.createdAt,
      })
      .from(auditLogs)
      .leftJoin(users, eq(users.id, auditLogs.actorUserId))
      .where(where)
      .orderBy(desc(auditLogs.id))
      .limit(pagination.limit)
      .offset(toOffset(pagination)),
    executor.select({ value: count() }).from(auditLogs).where(where),
  ]);

  return { items: rows, total: Number(totalRow?.value ?? 0) };
}

// --- Storage -----------------------------------------------------------------

export async function listLargestObjects(limit = 20) {
  return db
    .select({
      contentHash: storageObjects.contentHash,
      objectKey: storageObjects.objectKey,
      sizeBytes: storageObjects.sizeBytes,
      detectedMime: storageObjects.detectedMime,
      refCount: storageObjects.refCount,
      createdAt: storageObjects.createdAt,
    })
    .from(storageObjects)
    .orderBy(desc(storageObjects.sizeBytes))
    .limit(limit);
}

export async function listOrphanedObjects(olderThanHours: number, limit = 50) {
  const cutoff = new Date(Date.now() - olderThanHours * 3_600_000);
  return db
    .select({
      contentHash: storageObjects.contentHash,
      objectKey: storageObjects.objectKey,
      sizeBytes: storageObjects.sizeBytes,
      createdAt: storageObjects.createdAt,
    })
    .from(storageObjects)
    .where(and(eq(storageObjects.refCount, 0), sql`${storageObjects.createdAt} < ${cutoff}`))
    .orderBy(storageObjects.createdAt)
    .limit(limit);
}

// --- Reports -----------------------------------------------------------------

export interface ReportFilters {
  status?: 'pending' | 'reviewing' | 'resolved' | 'rejected';
  targetType?: string;
}

export async function listReports(
  filters: ReportFilters,
  pagination: PaginationInput,
  executor: Executor = db,
) {
  const predicates: SQL[] = [isNull(reports.deletedAt)];
  if (filters.status) predicates.push(eq(reports.status, filters.status));
  if (filters.targetType) {
    predicates.push(sql`${reports.targetType}::text = ${filters.targetType}`);
  }
  const where = and(...predicates)!;

  const [rows, [totalRow]] = await Promise.all([
    executor
      .select({
        id: reports.id,
        targetType: reports.targetType,
        targetId: reports.targetId,
        reason: reports.reason,
        details: reports.details,
        status: reports.status,
        createdAt: reports.createdAt,
        reporterId: reports.reporterUserId,
        reporterName: users.displayName,
        reporterEmail: users.email,
        resolvedAt: reports.resolvedAt,
        resolutionNote: reports.resolutionNote,
      })
      .from(reports)
      .innerJoin(users, eq(users.id, reports.reporterUserId))
      .where(where)
      .orderBy(desc(reports.createdAt))
      .limit(pagination.limit)
      .offset(toOffset(pagination)),
    executor.select({ value: count() }).from(reports).where(where),
  ]);

  return { items: rows, total: Number(totalRow?.value ?? 0) };
}

export async function resolveReport(
  executor: Executor,
  values: {
    reportId: string;
    status: 'resolved' | 'rejected' | 'reviewing';
    resolvedByUserId: string;
    note: string | null;
  },
): Promise<boolean> {
  const updated = await executor
    .update(reports)
    .set({
      status: values.status,
      resolvedByUserId: values.resolvedByUserId,
      resolvedAt: values.status === 'reviewing' ? null : new Date(),
      resolutionNote: values.note,
      updatedAt: new Date(),
    })
    .where(eq(reports.id, values.reportId))
    .returning({ id: reports.id });
  return updated.length > 0;
}

export async function findReportById(reportId: string, executor: Executor = db) {
  const rows = await executor.select().from(reports).where(eq(reports.id, reportId)).limit(1);
  return rows[0] ?? null;
}

/** Total bytes a user's live documents occupy, for the storage screen. */
export async function totalStoredBytes() {
  const [row] = await db
    .select({ value: sql<number>`COALESCE(SUM(size_bytes), 0)::bigint` })
    .from(documentFiles)
    .where(isNull(documentFiles.deletedAt));
  return Number(row?.value ?? 0);
}
