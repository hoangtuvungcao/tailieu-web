import { and, count, desc, eq, isNull } from 'drizzle-orm';

import { reports } from '../../db/schema/index.js';
import { toOffset, type PaginationInput } from '../../lib/pagination.js';
import type { Executor, Tx } from '../documents/documents.repository.js';

/**
 * Report persistence.
 *
 * Nothing here hydrates a target. The `(target_type, target_id)` pair is
 * polymorphic and carries no foreign key, so the only thing that can keep a
 * report honest is resolving the target through its owning module's visibility
 * predicate — and that lives in the service, where the viewer is known. A
 * repository function that returned a title would be a leak waiting for someone
 * to forget the second half.
 */

export type ReportTarget = 'document' | 'post' | 'comment' | 'user' | 'collection';

export interface InsertReportInput {
  reporterUserId: string;
  targetType: ReportTarget;
  targetId: string;
  reason: string;
  details: string | undefined;
}

/**
 * File a report.
 *
 * `onConflictDoNothing` targets the partial unique index that permits one open
 * report per (reporter, target). Returning no row is then the signal that a
 * pending report already exists — which is a *better* answer than catching a
 * `23505`, because it needs no error-shape archaeology: Drizzle wraps driver
 * errors, and the `code` ends up on a `cause` chain whose depth is a library
 * implementation detail.
 *
 * Note the index is partial on `status = 'pending'`, so this suppresses only a
 * duplicate *open* report. Reporting the same item again after a moderator
 * resolved the first one is a legitimate "it is still there" and inserts
 * normally.
 */
export async function insertReport(
  tx: Tx,
  input: InsertReportInput,
): Promise<{ id: string; createdAt: Date } | null> {
  const [row] = await tx
    .insert(reports)
    .values({
      reporterUserId: input.reporterUserId,
      targetType: input.targetType,
      targetId: input.targetId,
      reason: input.reason as never,
      details: input.details ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: reports.id, createdAt: reports.createdAt });

  return row ?? null;
}

/** The reporter's own open report on this target, if any. */
export async function findOpenReport(
  executor: Executor,
  reporterUserId: string,
  targetType: ReportTarget,
  targetId: string,
): Promise<{ id: string; createdAt: Date } | null> {
  const [row] = await executor
    .select({ id: reports.id, createdAt: reports.createdAt })
    .from(reports)
    .where(
      and(
        eq(reports.reporterUserId, reporterUserId),
        eq(reports.targetType, targetType),
        eq(reports.targetId, targetId),
        eq(reports.status, 'pending'),
        isNull(reports.deletedAt),
      ),
    )
    .limit(1);

  return row ?? null;
}

/**
 * A reporter's own history, newest first.
 *
 * Scoped to `reporterUserId` by the caller and never exposed unscoped: this is
 * what tells the interface whether to offer the report button at all.
 */
export async function listByReporter(
  executor: Executor,
  reporterUserId: string,
  pagination: PaginationInput,
): Promise<{ items: ReportSummaryRow[]; total: number }> {
  const where = and(eq(reports.reporterUserId, reporterUserId), isNull(reports.deletedAt));

  const [items, [totals]] = await Promise.all([
    executor
      .select({
        id: reports.id,
        targetType: reports.targetType,
        targetId: reports.targetId,
        reason: reports.reason,
        status: reports.status,
        createdAt: reports.createdAt,
        resolvedAt: reports.resolvedAt,
        resolutionNote: reports.resolutionNote,
      })
      .from(reports)
      .where(where)
      .orderBy(desc(reports.createdAt), desc(reports.id))
      .limit(pagination.limit)
      .offset(toOffset(pagination)),
    executor.select({ value: count() }).from(reports).where(where),
  ]);

  return { items, total: totals?.value ?? 0 };
}

export interface ReportSummaryRow {
  id: string;
  targetType: string;
  targetId: string;
  reason: string;
  status: string;
  createdAt: Date;
  resolvedAt: Date | null;
  resolutionNote: string | null;
}

/** How many open reports this user is carrying, for the admin user detail. */
export async function countOpenByReporter(
  executor: Executor,
  reporterUserId: string,
): Promise<number> {
  const [row] = await executor
    .select({ value: count() })
    .from(reports)
    .where(
      and(
        eq(reports.reporterUserId, reporterUserId),
        eq(reports.status, 'pending'),
        isNull(reports.deletedAt),
      ),
    );

  return row?.value ?? 0;
}
