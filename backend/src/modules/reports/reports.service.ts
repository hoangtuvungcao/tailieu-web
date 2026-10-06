import { and, eq, isNull } from 'drizzle-orm';

import { db } from '../../db/client.js';
import { AppError } from '../../lib/errors.js';
import { collections, comments, documents, posts, users } from '../../db/schema/index.js';
import {
  collectionVisibilityPredicate,
  documentVisibilityPredicate,
  postVisibilityPredicate,
} from '../social/shared/visibility.js';
import type { SocialActor } from '../social/shared/actor.js';
import * as repo from './reports.repository.js';
import type { ReportTarget } from './reports.repository.js';
import type { CreateReportBody } from './reports.schema.js';

/**
 * Report service.
 *
 * The whole file exists to answer one question safely: *may this person report
 * this thing?* Everything else is a single insert.
 *
 * Two rules drive the shape of it.
 *
 * **A report may not become an existence oracle.** "Document not found" and
 * "document you are not allowed to see" must be indistinguishable, so both come
 * out of one query: the visibility predicate is part of the WHERE clause, not a
 * check performed on a row fetched without it. If they were separate, anyone
 * could walk a list of UUIDs and learn which ones name real private documents
 * by watching which error came back.
 *
 * **Nobody moderates themselves.** Reporting your own content is refused, and
 * refused with a message that says what to do instead, because the useful
 * action for your own document is to edit or delete it.
 */

export interface CreateReportResult {
  id: string;
  status: 'pending';
  createdAt: string;
}

/** Who owns the target, so the self-report rule can be applied. */
interface ResolvedTarget {
  ownerUserId: string;
}

/**
 * Resolve a target to its owner, or refuse.
 *
 * Every branch returns either a row or an error of the SAME kind that a
 * genuinely missing target produces. That symmetry is the security property,
 * not a stylistic preference.
 */
async function resolveTarget(
  targetType: ReportTarget,
  targetId: string,
  actor: SocialActor,
): Promise<ResolvedTarget> {
  if (targetType === 'document') {
    const [row] = await db
      .select({ ownerUserId: documents.ownerUserId })
      .from(documents)
      .where(and(eq(documents.id, targetId), documentVisibilityPredicate(actor.viewer)))
      .limit(1);

    // The message names the target type rather than the reason. "Không tìm
    // thấy" covers both "does not exist" and "not yours to see", which is the
    // point.
    if (!row) throw new AppError('DOCUMENT_NOT_FOUND', 'Không tìm thấy tài liệu.');
    return { ownerUserId: row.ownerUserId };
  }

  if (targetType === 'post') {
    const [row] = await db
      .select({ ownerUserId: posts.authorUserId })
      .from(posts)
      .where(and(eq(posts.id, targetId), postVisibilityPredicate(actor.viewer)))
      .limit(1);

    if (!row) throw new AppError('NOT_FOUND', 'Không tìm thấy bài đăng.');
    return { ownerUserId: row.ownerUserId };
  }

  if (targetType === 'collection') {
    const [row] = await db
      .select({ ownerUserId: collections.ownerUserId })
      .from(collections)
      .where(and(eq(collections.id, targetId), collectionVisibilityPredicate(actor.viewer)))
      .limit(1);

    if (!row) throw new AppError('NOT_FOUND', 'Không tìm thấy bộ sưu tập.');
    return { ownerUserId: row.ownerUserId };
  }

  if (targetType === 'comment') {
    // A comment has no visibility of its own; it inherits its target's. So the
    // parent is resolved and checked rather than the comment alone — otherwise
    // a comment id would be a way to confirm that a private document has
    // discussion on it.
    const [row] = await db
      .select({
        authorUserId: comments.authorUserId,
        targetType: comments.targetType,
        targetId: comments.targetId,
      })
      .from(comments)
      .where(eq(comments.id, targetId))
      .limit(1);

    if (!row) throw new AppError('NOT_FOUND', 'Không tìm thấy bình luận.');

    const parentVisible =
      row.targetType === 'document'
        ? await isDocumentVisible(row.targetId, actor)
        : await isPostVisible(row.targetId, actor);

    if (!parentVisible) throw new AppError('NOT_FOUND', 'Không tìm thấy bình luận.');

    return { ownerUserId: row.authorUserId };
  }

  // `anonymizedAt` rather than `status`, matching every other module that asks
  // whether an account still exists: a deactivated account's content is still
  // on the site and can still be reported, while an anonymised one has been
  // erased and has nothing left to point at.
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, targetId), isNull(users.anonymizedAt)))
    .limit(1);

  if (!row) throw new AppError('USER_NOT_FOUND', 'Không tìm thấy người dùng.');
  return { ownerUserId: row.id };
}

async function isDocumentVisible(documentId: string, actor: SocialActor): Promise<boolean> {
  const [row] = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.id, documentId), documentVisibilityPredicate(actor.viewer)))
    .limit(1);
  return Boolean(row);
}

async function isPostVisible(postId: string, actor: SocialActor): Promise<boolean> {
  const [row] = await db
    .select({ id: posts.id })
    .from(posts)
    .where(and(eq(posts.id, postId), postVisibilityPredicate(actor.viewer)))
    .limit(1);
  return Boolean(row);
}

/**
 * File a report.
 *
 * The duplicate case is answered from the insert itself rather than by a
 * read-then-write check: two submissions racing each other would both pass a
 * preliminary SELECT and the loser would surface as a raw constraint error. The
 * partial unique index is the only thing that can actually decide this, so the
 * insert is where the question is asked.
 */
export async function createReport(
  actor: SocialActor,
  input: CreateReportBody,
): Promise<CreateReportResult> {
  const target = await resolveTarget(input.targetType, input.targetId, actor);

  if (target.ownerUserId === actor.userId) {
    throw new AppError(
      'VALIDATION_FAILED',
      'Đây là nội dung của chính bạn. Bạn có thể tự sửa hoặc xoá thay vì báo cáo.',
    );
  }

  return db.transaction(async (tx) => {
    const row = await repo.insertReport(tx, {
      reporterUserId: actor.userId,
      targetType: input.targetType,
      targetId: input.targetId,
      reason: input.reason,
      details: input.details,
    });

    if (!row) {
      throw new AppError(
        'CONFLICT',
        'Bạn đã báo cáo nội dung này rồi và đang chờ xử lý.',
      );
    }

    return {
      id: row.id,
      status: 'pending' as const,
      createdAt: row.createdAt.toISOString(),
    };
  });
}

/** The reporter's own reports, so the interface knows what it has already sent. */
export async function listMyReports(
  actor: SocialActor,
  pagination: { page: number; limit: number },
): Promise<{ items: repo.ReportSummaryRow[]; total: number }> {
  return repo.listByReporter(db, actor.userId, pagination);
}

/**
 * Whether the viewer already has an open report on this target.
 *
 * Separate from the list endpoint because the document page asks this question
 * about exactly one thing, on every render, and paginating a history to answer
 * it would be absurd.
 */
export async function getReportState(
  actor: SocialActor,
  targetType: ReportTarget,
  targetId: string,
): Promise<{ reported: boolean }> {
  const existing = await repo.findOpenReport(db, actor.userId, targetType, targetId);
  return { reported: Boolean(existing) };
}

export type { ReportTarget };
