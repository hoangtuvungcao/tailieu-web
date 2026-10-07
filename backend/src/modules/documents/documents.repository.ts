import { and, asc, count, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';

import { db, type Database } from '../../db/client.js';
import {
  academicYears,
  courses,
  documentFiles,
  documentModerationEvents,
  documentRatings,
  documentTags,
  documents,
  documentTypes,
  downloadEvents,
  faculties,
  programs,
  semesters,
  storageObjects,
  subjects,
  tags,
  users,
} from '../../db/schema/index.js';
import { toOffset, type PaginationInput } from '../../lib/pagination.js';
import type { DocumentRow } from './documents.mapper.js';

export type { DocumentRow };
import type { ListDocumentsQuery } from './documents.schema.js';

export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
export type Executor = Tx | typeof db;

/**
 * Document data access.
 *
 * The single most important thing in this file: visibility is enforced in the
 * WHERE clause, never by filtering results in JavaScript afterwards.
 *
 * If the repository returned rows the caller may not see and relied on a
 * service layer to filter them, then a single forgotten filter — in this
 * module, in search, in an export job, in the admin panel — leaks private
 * documents. Putting the predicate in SQL means the rows are never loaded, so
 * there is nothing to forget. It also lets the partial indexes do their job.
 *
 * Every predicate here uses Drizzle column references rather than hand-written
 * aliases, because Drizzle names tables itself and a hand-written `d.status`
 * silently fails to resolve in a joined query.
 */

export type CopyrightStatus =
  | 'unknown'
  | 'cleared'
  | 'permission_granted'
  | 'public_domain'
  | 'fair_use'
  | 'infringing';

export interface Viewer {
  userId: string | null;
  /** True when the viewer holds a platform-wide moderation role. */
  isModerator: boolean;
  /** Faculty ids the viewer moderates. Ignored when `isModerator` is true. */
  facultyIds: string[];
}

/**
 * "May this viewer see this row?"
 *
 * The rules, in order of who they apply to:
 *
 *   Owner        always sees their own document, whatever its state. Losing
 *                sight of a rejected upload with no explanation is worse than
 *                the rejection itself.
 *   Moderator    sees everything within their scope, including private and
 *                unpublished documents, because that is what moderating means.
 *   Scoped mod   sees everything within their faculties only. This is the
 *                clause that makes `faculty_moderator` real rather than
 *                decorative.
 *   Signed in    sees published `internal` documents.
 *   Anonymous    sees only published `public` documents.
 */
export function visibilityPredicate(viewer: Viewer): SQL {
  const clauses: SQL[] = [
    sql`${documents.status} = 'published' AND ${documents.visibility} = 'public'`,
  ];

  if (viewer.userId) {
    clauses.push(
      sql`${documents.status} = 'published' AND ${documents.visibility} = 'internal'`,
    );
    clauses.push(sql`${documents.ownerUserId} = ${viewer.userId}`);
  }

  if (viewer.isModerator) {
    clauses.push(sql`true`);
  } else if (viewer.facultyIds.length > 0) {
    // Scoped moderator: only within their faculties. An empty list grants
    // nothing, which is the correct default for a scoped role granted with a
    // bad faculty id.
    // `inArray`, not `= ANY($1::uuid[])`. A JavaScript array does not
    // serialise to a valid Postgres array literal through a bound parameter —
    // a single-element array arrives as the bare value and Postgres rejects it
    // with `malformed array literal`. That breaks faculty scoping for exactly
    // the case it exists for (a moderator scoped to one faculty) and fails
    // closed with a 500, which reads as a server bug rather than a permission
    // decision.
    clauses.push(inArray(documents.facultyId, viewer.facultyIds));
  }

  return and(sql`${documents.deletedAt} IS NULL`, or(...clauses))!;
}

/** Columns shared by the list and detail queries. */
const documentColumns = {
  id: documents.id,
  slug: documents.slug,
  title: documents.title,
  description: documents.description,
  status: documents.status,
  visibility: documents.visibility,
  language: documents.language,
  fileKind: documents.fileKind,
  sizeBytes: documents.sizeBytes,
  pageCount: documents.pageCount,
  downloadCount: documents.downloadCount,
  viewCount: documents.viewCount,
  likeCount: documents.likeCount,
  commentCount: documents.commentCount,
  ratingCount: documents.ratingCount,
  ratingSum: documents.ratingSum,
  ratingAvg: documents.ratingAvg,
  license: documents.license,
  copyrightStatus: documents.copyrightStatus,
  source: documents.source,
  attribution: documents.attribution,
  publishedAt: documents.publishedAt,
  createdAt: documents.createdAt,
  updatedAt: documents.updatedAt,
  ownerUserId: documents.ownerUserId,
  ownerDisplayName: users.displayName,
  ownerAvatarUrl: users.avatarUrl,
  facultyId: documents.facultyId,
  facultyName: faculties.name,
  facultyCode: faculties.code,
  programId: documents.programId,
  programName: programs.name,
  programCode: programs.code,
  subjectId: documents.subjectId,
  subjectName: subjects.name,
  subjectCode: subjects.code,
  courseId: documents.courseId,
  courseName: courses.name,
  courseCode: courses.code,
  documentTypeId: documents.documentTypeId,
  documentTypeName: documentTypes.name,
  documentTypeCode: documentTypes.code,
  academicYearId: documents.academicYearId,
  academicYearCode: academicYears.code,
  academicYearName: academicYears.name,
  semesterId: documents.semesterId,
  semesterCode: semesters.code,
  semesterName: semesters.name,
};

/**
 * `rating_avg` is a Postgres NUMERIC and arrives as a string. Coerced here so
 * every consumer sees a number and cannot accidentally do a string comparison
 * on a rating.
 */
function normaliseRow(row: Record<string, unknown>): DocumentRow {
  return {
    ...row,
    sizeBytes: row.sizeBytes === null ? null : Number(row.sizeBytes),
    downloadCount: Number(row.downloadCount ?? 0),
    viewCount: Number(row.viewCount ?? 0),
    likeCount: Number(row.likeCount ?? 0),
    commentCount: Number(row.commentCount ?? 0),
    ratingCount: Number(row.ratingCount ?? 0),
    ratingSum: Number(row.ratingSum ?? 0),
    ratingAvg: row.ratingAvg === null || row.ratingAvg === undefined ? null : String(row.ratingAvg),
  } as DocumentRow;
}

function baseDocumentQuery(executor: Executor) {
  return executor
    .select(documentColumns)
    .from(documents)
    .innerJoin(users, eq(users.id, documents.ownerUserId))
    .innerJoin(faculties, eq(faculties.id, documents.facultyId))
    .innerJoin(documentTypes, eq(documentTypes.id, documents.documentTypeId))
    .leftJoin(programs, eq(programs.id, documents.programId))
    .leftJoin(subjects, eq(subjects.id, documents.subjectId))
    .leftJoin(courses, eq(courses.id, documents.courseId))
    .leftJoin(academicYears, eq(academicYears.id, documents.academicYearId))
    .leftJoin(semesters, eq(semesters.id, documents.semesterId));
}

/**
 * Full-text match against the trigger-maintained haystack.
 *
 * Two matching strategies, OR'd, because neither alone is sufficient:
 *
 *   1. `tsv @@ plainto_tsquery(...)` — whole-word matching against the GIN
 *      index. This is the fast, ranked path and handles the common case.
 *
 *   2. `immutable_unaccent(search_text) ILIKE ...` — partial-word and
 *      substring matching, backed by the trigram index. Without this, typing
 *      "nghe" finds nothing because `tsquery` only matches complete tokens.
 *
 * BOTH sides are unaccented. Unaccenting only the pattern is a subtle and
 * completely silent failure: `search_text` stores the original accented text
 * ("Công nghệ"), so `'%cong nghe%'` matches nothing, and the search simply
 * returns zero results for every diacritic-free query — which, for Vietnamese
 * users typing without tone marks, is most of them.
 */
function textPredicate(term: string): SQL {
  const pattern = `%${term}%`;
  return sql`(
    ${documents.tsv} @@ plainto_tsquery('simple', immutable_unaccent(${term}))
    OR immutable_unaccent(${documents.searchText}) ILIKE immutable_unaccent(${pattern})
  )`;
}

function buildFilters(filters: ListDocumentsQuery, viewer: Viewer): SQL {
  const clauses: SQL[] = [visibilityPredicate(viewer)];

  if (filters.q) clauses.push(textPredicate(filters.q));
  if (filters.facultyId) clauses.push(eq(documents.facultyId, filters.facultyId));
  if (filters.programId) clauses.push(eq(documents.programId, filters.programId));
  if (filters.subjectId) clauses.push(eq(documents.subjectId, filters.subjectId));
  if (filters.courseId) clauses.push(eq(documents.courseId, filters.courseId));
  if (filters.academicYearId) clauses.push(eq(documents.academicYearId, filters.academicYearId));
  if (filters.semesterId) clauses.push(eq(documents.semesterId, filters.semesterId));
  if (filters.documentTypeId) clauses.push(eq(documents.documentTypeId, filters.documentTypeId));
  if (filters.fileKind) clauses.push(eq(documents.fileKind, filters.fileKind));
  if (filters.visibility) clauses.push(eq(documents.visibility, filters.visibility));
  if (filters.status) clauses.push(eq(documents.status, filters.status));
  if (filters.ownerUserId) clauses.push(eq(documents.ownerUserId, filters.ownerUserId));
  if (filters.mine && viewer.userId) clauses.push(eq(documents.ownerUserId, viewer.userId));

  if (filters.tag) {
    clauses.push(
      sql`EXISTS (
        SELECT 1 FROM document_tags dt
        JOIN tags t ON t.id = dt.tag_id
        WHERE dt.document_id = ${documents.id}
          AND (t.slug = ${filters.tag} OR immutable_unaccent(t.name) ILIKE immutable_unaccent(${'%' + filters.tag + '%'}))
      )`,
    );
  }

  return and(...clauses)!;
}

/**
 * Sort order for each supported mode.
 *
 * `relevance` without a search term falls back to recency: relevance to nothing
 * is not a meaningful ordering, and Postgres would otherwise return rows in an
 * arbitrary, unstable order — so page 2 could repeat or skip rows from page 1.
 */
function orderClauses(sort: ListDocumentsQuery['sort'], term: string | undefined): SQL[] {
  switch (sort) {
    case 'relevance':
      return term
        ? [
            sql`ts_rank_cd(${documents.tsv}, plainto_tsquery('simple', immutable_unaccent(${term}))) DESC`,
            sql`${documents.publishedAt} DESC NULLS LAST`,
          ]
        : [sql`${documents.createdAt} DESC`];
    case 'oldest':
      return [sql`${documents.createdAt} ASC`];
    case 'popular':
      return [sql`${documents.downloadCount} DESC`, sql`${documents.publishedAt} DESC NULLS LAST`];
    case 'rated':
      return [sql`${documents.ratingAvg} DESC NULLS LAST`, sql`${documents.ratingCount} DESC`];
    case 'title':
      return [sql`${documents.title} ASC`];
    case 'newest':
    default:
      return [sql`${documents.createdAt} DESC`];
  }
}

export async function listDocuments(
  filters: ListDocumentsQuery,
  pagination: PaginationInput,
  viewer: Viewer,
  executor: Executor = db,
) {
  const where = buildFilters(filters, viewer);

  // The relevance sort needs the real search term, so it is bound separately
  // from the ILIKE prefilter rather than reusing a placeholder.
  const ordering = orderClauses(filters.sort, filters.q);

  const [rows, [totalRow]] = await Promise.all([
    baseDocumentQuery(executor)
      .where(where)
      .orderBy(...ordering)
      .limit(pagination.limit)
      .offset(toOffset(pagination)),
    executor
      .select({ value: count() })
      .from(documents)
      .innerJoin(faculties, eq(faculties.id, documents.facultyId))
      .where(where),
  ]);

  return {
    items: rows.map((r) => normaliseRow(r as Record<string, unknown>)),
    total: Number(totalRow?.value ?? 0),
  };
}

export async function findDocumentById(
  id: string,
  viewer: Viewer,
  executor: Executor = db,
): Promise<DocumentRow | null> {
  const rows = await baseDocumentQuery(executor)
    .where(and(eq(documents.id, id), visibilityPredicate(viewer)))
    .limit(1);

  const row = rows[0];
  return row ? normaliseRow(row as Record<string, unknown>) : null;
}

/**
 * Fetch a document ignoring visibility, for authorization decisions.
 *
 * Used by the download path, which must distinguish "does not exist" from
 * "exists but you may not see it" — and must answer both with 404 so the
 * distinction is not observable.
 */
export async function findDocumentUnscoped(
  id: string,
  executor: Executor = db,
): Promise<DocumentRow | null> {
  const rows = await baseDocumentQuery(executor)
    .where(and(eq(documents.id, id), isNull(documents.deletedAt)))
    .limit(1);

  const row = rows[0];
  return row ? normaliseRow(row as Record<string, unknown>) : null;
}

export async function findDocumentFiles(documentId: string, executor: Executor = db) {
  const rows = await executor
    .select({
      id: documentFiles.id,
      originalName: documentFiles.originalName,
      sizeBytes: documentFiles.sizeBytes,
      detectedMime: documentFiles.detectedMime,
      fileKind: documentFiles.fileKind,
      isPrimary: documentFiles.isPrimary,
      status: documentFiles.status,
      extension: documentFiles.extension,
      pageCount: documentFiles.pageCount,
      previewStatus: documentFiles.previewStatus,
      previewContentHash: documentFiles.previewContentHash,
      // Storage coordinates. These stay inside the service layer and are
      // stripped by the mapper before anything reaches a client.
      objectKey: storageObjects.objectKey,
      bucket: storageObjects.bucket,
    })
    .from(documentFiles)
    .innerJoin(storageObjects, eq(storageObjects.contentHash, documentFiles.contentHash))
    .where(and(eq(documentFiles.documentId, documentId), isNull(documentFiles.deletedAt)))
    .orderBy(desc(documentFiles.isPrimary), asc(documentFiles.createdAt));

  return rows;
}

export async function findDocumentTags(documentId: string, executor: Executor = db) {
  return executor
    .select({ id: tags.id, slug: tags.slug, name: tags.name })
    .from(documentTags)
    .innerJoin(tags, eq(tags.id, documentTags.tagId))
    .where(eq(documentTags.documentId, documentId))
    .orderBy(asc(tags.name));
}

export async function findFileById(
  documentId: string,
  fileId: string,
  executor: Executor = db,
) {
  const rows = await executor
    .select({
      id: documentFiles.id,
      originalName: documentFiles.originalName,
      sizeBytes: documentFiles.sizeBytes,
      detectedMime: documentFiles.detectedMime,
      status: documentFiles.status,
      objectKey: storageObjects.objectKey,
      bucket: storageObjects.bucket,
    })
    .from(documentFiles)
    .innerJoin(storageObjects, eq(storageObjects.contentHash, documentFiles.contentHash))
    .where(
      and(
        eq(documentFiles.id, fileId),
        eq(documentFiles.documentId, documentId),
        isNull(documentFiles.deletedAt),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

// --- Writes ------------------------------------------------------------------

export async function insertDocument(
  executor: Executor,
  values: {
    title: string;
    description: string | null;
    documentTypeId: string;
    ownerUserId: string;
    facultyId: string;
    programId: string | null;
    subjectId: string | null;
    courseId: string | null;
    academicYearId: string | null;
    semesterId: string | null;
    visibility: 'public' | 'internal' | 'private';
    status: 'draft' | 'pending_review' | 'published';
    language: string;
    license: string | null;
    copyrightStatus: CopyrightStatus;
    source: string | null;
    attribution: string | null;
    uploaderConfirmed: boolean;
    publishedAt: Date | null;
  },
): Promise<{ id: string }> {
  const [row] = await executor.insert(documents).values(values).returning({ id: documents.id });
  return { id: row!.id };
}

export async function updateDocument(
  executor: Executor,
  id: string,
  values: Partial<{
    title: string;
    description: string | null;
    documentTypeId: string;
    programId: string | null;
    subjectId: string | null;
    courseId: string | null;
    academicYearId: string | null;
    semesterId: string | null;
    visibility: 'public' | 'internal' | 'private';
    language: string;
    license: string | null;
    copyrightStatus: CopyrightStatus;
    source: string | null;
    attribution: string | null;
    fileKind: 'pdf' | 'document' | 'spreadsheet' | 'presentation' | 'archive' | 'image' | 'text' | 'code' | 'other';
    sizeBytes: number;
    pageCount: number;
  }>,
): Promise<void> {
  await executor
    .update(documents)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(documents.id, id));
}

export async function softDeleteDocument(executor: Executor, id: string): Promise<void> {
  await executor
    .update(documents)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(documents.id, id));
}

export async function attachFile(
  executor: Executor,
  values: {
    documentId: string;
    contentHash: Buffer;
    originalName: string;
    extension: string | null;
    sizeBytes: number;
    declaredMime: string | null;
    detectedMime: string;
    fileKind: 'pdf' | 'document' | 'spreadsheet' | 'presentation' | 'archive' | 'image' | 'text' | 'code' | 'other';
    isPrimary: boolean;
    status: 'pending' | 'ready' | 'failed';
    pageCount: number | null;
    previewStatus: 'none' | 'queued' | 'processing' | 'ready' | 'failed' | 'unsupported';
    createdAt?: Date;
  },
): Promise<{ id: string }> {
  const [row] = await executor
    .insert(documentFiles)
    .values(values)
    .returning({ id: documentFiles.id });
  return { id: row!.id };
}

/**
 * Increment a storage object's reference count.
 *
 * Must run in the same transaction as the `document_files` insert. If the two
 * could diverge, a document could reference an object whose count reads zero,
 * and the reaper would delete bytes still in use — silent data loss that only
 * surfaces as a broken download months later.
 */
export async function incrementStorageRef(executor: Executor, contentHash: Buffer): Promise<void> {
  await executor
    .update(storageObjects)
    .set({ refCount: sql`${storageObjects.refCount} + 1` })
    .where(eq(storageObjects.contentHash, contentHash));
}

export async function decrementStorageRef(executor: Executor, contentHash: Buffer): Promise<number> {
  const [row] = await executor
    .update(storageObjects)
    .set({ refCount: sql`GREATEST(${storageObjects.refCount} - 1, 0)` })
    .where(eq(storageObjects.contentHash, contentHash))
    .returning({ refCount: storageObjects.refCount });
  return Number(row?.refCount ?? 0);
}

/** Upsert tags by slug and return their ids. */
export async function upsertTags(executor: Executor, names: string[]): Promise<string[]> {
  if (names.length === 0) return [];

  const ids: string[] = [];
  for (const name of names) {
    const slug = name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .replace(/Đ/g, 'D')
      .toLowerCase()
      .replace(/[^a-z0-9+#.-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);

    if (!slug) continue;

    const [row] = await executor
      .insert(tags)
      .values({ slug, name })
      .onConflictDoUpdate({ target: tags.slug, set: { name } })
      .returning({ id: tags.id });

    if (row) ids.push(row.id);
  }

  return ids;
}

export async function replaceDocumentTags(
  executor: Executor,
  documentId: string,
  tagIds: string[],
): Promise<void> {
  await executor.delete(documentTags).where(eq(documentTags.documentId, documentId));
  if (tagIds.length === 0) return;
  await executor
    .insert(documentTags)
    .values(tagIds.map((tagId) => ({ documentId, tagId })))
    .onConflictDoNothing();
}

export async function recordDownload(
  executor: Executor,
  values: {
    documentId: string;
    fileId: string | null;
    userId: string | null;
    ip: string | null;
    userAgent: string | null;
    referer: string | null;
    requestId: string | null;
  },
): Promise<void> {
  await executor.insert(downloadEvents).values(values);
  await executor
    .update(documents)
    .set({ downloadCount: sql`${documents.downloadCount} + 1` })
    .where(eq(documents.id, values.documentId));
}

export async function incrementViewCount(executor: Executor, documentId: string): Promise<void> {
  await executor
    .update(documents)
    .set({ viewCount: sql`${documents.viewCount} + 1` })
    .where(eq(documents.id, documentId));
}

// --- Ratings -----------------------------------------------------------------

export async function findUserRating(
  executor: Executor,
  documentId: string,
  userId: string,
): Promise<{ rating: number; review: string | null } | null> {
  const rows = await executor
    .select({ rating: documentRatings.rating, review: documentRatings.review })
    .from(documentRatings)
    .where(and(eq(documentRatings.documentId, documentId), eq(documentRatings.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Insert or replace a rating and recompute the document's aggregate.
 *
 * The aggregate is recalculated from the source rows rather than incremented,
 * because an increment on an *update* would double-count: the user changed
 * their mind from 3 to 5, not added a second vote. Recomputing is one indexed
 * aggregate and is impossible to get subtly wrong.
 */
export async function upsertRating(
  executor: Executor,
  values: { documentId: string; userId: string; rating: number; review: string | null },
): Promise<void> {
  await executor
    .insert(documentRatings)
    .values(values)
    .onConflictDoUpdate({
      target: [documentRatings.documentId, documentRatings.userId],
      set: { rating: values.rating, review: values.review, updatedAt: new Date() },
    });

  await executor.execute(sql`
    UPDATE documents d
       SET rating_count = agg.cnt,
           rating_sum   = agg.total,
           updated_at   = now()
      FROM (
        SELECT COUNT(*)::int AS cnt, COALESCE(SUM(rating), 0)::int AS total
          FROM document_ratings
         WHERE document_id = ${values.documentId}
      ) agg
     WHERE d.id = ${values.documentId}
  `);
}

export async function deleteRating(
  executor: Executor,
  documentId: string,
  userId: string,
): Promise<void> {
  await executor
    .delete(documentRatings)
    .where(and(eq(documentRatings.documentId, documentId), eq(documentRatings.userId, userId)));

  await executor.execute(sql`
    UPDATE documents d
       SET rating_count = agg.cnt,
           rating_sum   = agg.total,
           updated_at   = now()
      FROM (
        SELECT COUNT(*)::int AS cnt, COALESCE(SUM(rating), 0)::int AS total
          FROM document_ratings
         WHERE document_id = ${documentId}
      ) agg
     WHERE d.id = ${documentId}
  `);
}

export async function listRatings(documentId: string, pagination: PaginationInput) {
  const [rows, [totalRow]] = await Promise.all([
    db
      .select({
        rating: documentRatings.rating,
        review: documentRatings.review,
        createdAt: documentRatings.createdAt,
        userId: users.id,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
      })
      .from(documentRatings)
      .innerJoin(users, eq(users.id, documentRatings.userId))
      .where(eq(documentRatings.documentId, documentId))
      .orderBy(desc(documentRatings.createdAt))
      .limit(pagination.limit)
      .offset(toOffset(pagination)),
    db
      .select({ value: count() })
      .from(documentRatings)
      .where(eq(documentRatings.documentId, documentId)),
  ]);

  return { items: rows, total: Number(totalRow?.value ?? 0) };
}

// --- Moderation --------------------------------------------------------------

export async function setDocumentStatus(
  executor: Executor,
  values: {
    documentId: string;
    fromStatus: string;
    toStatus: 'draft' | 'pending_review' | 'published' | 'rejected' | 'archived';
    actorUserId: string;
    reason: string | null;
  },
): Promise<void> {
  await executor
    .update(documents)
    .set({
      status: values.toStatus,
      ...(values.toStatus === 'published' ? { publishedAt: new Date() } : {}),
      moderatedBy: values.actorUserId,
      moderatedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(documents.id, values.documentId));

  await executor.insert(documentModerationEvents).values({
    documentId: values.documentId,
    actorUserId: values.actorUserId,
    fromStatus: values.fromStatus as 'draft',
    toStatus: values.toStatus,
    reason: values.reason,
  });
}

/**
 * Moderation queue, scoped to the moderator's faculties.
 *
 * The scope is applied in SQL. A faculty moderator for Information Technology
 * must not be able to list, and therefore not act on, a Medicine document —
 * and enforcing that here rather than after the query means those rows are
 * never loaded at all.
 */
export async function listModerationQueue(
  viewer: Viewer,
  filters: { status?: string; facultyId?: string },
  pagination: PaginationInput,
) {
  const clauses: SQL[] = [isNull(documents.deletedAt)];

  if (filters.status) {
    clauses.push(sql`${documents.status} = ${filters.status}`);
  } else {
    clauses.push(sql`${documents.status} = 'pending_review'`);
  }

  if (filters.facultyId) clauses.push(eq(documents.facultyId, filters.facultyId));

  if (!viewer.isModerator) {
    if (viewer.facultyIds.length === 0) {
      // No scope and no global rights: an empty result, not everything.
      clauses.push(sql`false`);
    } else {
      // `inArray`, not `= ANY($1::uuid[])`. A JavaScript array does not
    // serialise to a valid Postgres array literal through a bound parameter —
    // a single-element array arrives as the bare value and Postgres rejects it
    // with `malformed array literal`. That breaks faculty scoping for exactly
    // the case it exists for (a moderator scoped to one faculty) and fails
    // closed with a 500, which reads as a server bug rather than a permission
    // decision.
    clauses.push(inArray(documents.facultyId, viewer.facultyIds));
    }
  }

  const where = and(...clauses)!;

  const [rows, [totalRow]] = await Promise.all([
    baseDocumentQuery(db)
      .where(where)
      .orderBy(asc(documents.createdAt))
      .limit(pagination.limit)
      .offset(toOffset(pagination)),
    db
      .select({ value: count() })
      .from(documents)
      .innerJoin(faculties, eq(faculties.id, documents.facultyId))
      .where(where),
  ]);

  return {
    items: rows.map((r) => normaliseRow(r as Record<string, unknown>)),
    total: Number(totalRow?.value ?? 0),
  };
}

/** Resolve storage coordinates for a content hash, used when attaching uploads. */
export async function findStorageObjectsByHashes(
  executor: Executor,
  hashes: Buffer[],
): Promise<{ contentHash: Buffer; objectKey: string; sizeBytes: number; detectedMime: string }[]> {
  if (hashes.length === 0) return [];
  const rows = await executor
    .select({
      contentHash: storageObjects.contentHash,
      objectKey: storageObjects.objectKey,
      sizeBytes: storageObjects.sizeBytes,
      detectedMime: storageObjects.detectedMime,
    })
    .from(storageObjects)
    .where(inArray(storageObjects.contentHash, hashes));
  return rows.map((r) => ({ ...r, sizeBytes: Number(r.sizeBytes) }));
}

/**
 * Resolve the converted preview artifact for a file.
 *
 * Separate from `findDocumentFiles` because it joins `storage_objects` a second
 * time — on `preview_content_hash` rather than `content_hash` — and doing both
 * in one query would need two aliased joins for no benefit, since the preview
 * is only fetched by the one endpoint that serves it.
 */
export async function findPreviewObject(
  documentId: string,
  fileId: string,
  executor: Executor = db,
) {
  const rows = await executor
    .select({
      contentHash: storageObjects.contentHash,
      objectKey: storageObjects.objectKey,
      bucket: storageObjects.bucket,
      sizeBytes: storageObjects.sizeBytes,
      previewStatus: documentFiles.previewStatus,
      previewError: documentFiles.previewError,
      originalName: documentFiles.originalName,
      detectedMime: documentFiles.detectedMime,
    })
    .from(documentFiles)
    .innerJoin(storageObjects, eq(storageObjects.contentHash, documentFiles.previewContentHash))
    .where(
      and(
        eq(documentFiles.id, fileId),
        eq(documentFiles.documentId, documentId),
        isNull(documentFiles.deletedAt),
      ),
    )
    .limit(1);

  const row = rows[0];
  return row ? { ...row, sizeBytes: Number(row.sizeBytes) } : null;
}

/** The file row alone, for reading preview status without the artifact. */
export async function findFilePreviewState(
  documentId: string,
  fileId: string,
  executor: Executor = db,
) {
  const rows = await executor
    .select({
      id: documentFiles.id,
      previewStatus: documentFiles.previewStatus,
      previewError: documentFiles.previewError,
      originalName: documentFiles.originalName,
      detectedMime: documentFiles.detectedMime,
      fileKind: documentFiles.fileKind,
    })
    .from(documentFiles)
    .where(
      and(
        eq(documentFiles.id, fileId),
        eq(documentFiles.documentId, documentId),
        isNull(documentFiles.deletedAt),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

/** Tag cloud for the browse page. */
export async function popularTags(limit = 50) {
  return db
    .select({ id: tags.id, slug: tags.slug, name: tags.name, usageCount: tags.usageCount })
    .from(tags)
    .orderBy(desc(tags.usageCount), asc(tags.name))
    .limit(limit);
}

export async function updateFileMeta(
  fileId: string,
  values: {
    detectedMime?: string;
    fileKind?: typeof documentFiles.$inferInsert['fileKind'];
    extension?: string | null;
    previewStatus?: 'none' | 'queued' | 'processing' | 'ready' | 'failed' | 'unsupported';
    previewContentHash?: Buffer | null;
    previewError?: string | null;
  },
  executor: Executor = db,
) {
  await executor
    .update(documentFiles)
    .set(values)
    .where(eq(documentFiles.id, fileId));
}

export async function findPendingConversionFiles(limit = 100, executor: Executor = db) {
  return executor
    .select({
      fileId: documentFiles.id,
      documentId: documentFiles.documentId,
      originalName: documentFiles.originalName,
      detectedMime: documentFiles.detectedMime,
      fileKind: documentFiles.fileKind,
      previewStatus: documentFiles.previewStatus,
      previewContentHash: documentFiles.previewContentHash,
      bucket: storageObjects.bucket,
      objectKey: storageObjects.objectKey,
    })
    .from(documentFiles)
    .innerJoin(storageObjects, eq(storageObjects.contentHash, documentFiles.contentHash))
    .where(
      and(
        isNull(documentFiles.deletedAt),
        or(
          eq(documentFiles.previewStatus, 'queued'),
          and(
            eq(documentFiles.previewStatus, 'ready'),
            isNull(documentFiles.previewContentHash),
          ),
          and(
            inArray(documentFiles.detectedMime, ['application/zip', 'application/x-cfb']),
            or(
              ilike(documentFiles.originalName, '%.docx'),
              ilike(documentFiles.originalName, '%.pptx'),
              ilike(documentFiles.originalName, '%.xlsx'),
              ilike(documentFiles.originalName, '%.doc'),
              ilike(documentFiles.originalName, '%.ppt'),
              ilike(documentFiles.originalName, '%.xls'),
              ilike(documentFiles.originalName, '%.odt'),
              ilike(documentFiles.originalName, '%.odp'),
              ilike(documentFiles.originalName, '%.ods'),
            ),
          ),
          and(
            eq(documentFiles.previewStatus, 'none'),
            or(
              inArray(documentFiles.detectedMime, [
                'application/msword',
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                'application/vnd.oasis.opendocument.text',
                'application/rtf',
                'application/vnd.ms-excel',
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                'application/vnd.oasis.opendocument.spreadsheet',
                'text/csv',
                'application/vnd.ms-powerpoint',
                'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                'application/vnd.oasis.opendocument.presentation',
              ]),
              or(
                ilike(documentFiles.originalName, '%.docx'),
                ilike(documentFiles.originalName, '%.pptx'),
                ilike(documentFiles.originalName, '%.xlsx'),
                ilike(documentFiles.originalName, '%.doc'),
                ilike(documentFiles.originalName, '%.ppt'),
                ilike(documentFiles.originalName, '%.xls'),
                ilike(documentFiles.originalName, '%.odt'),
                ilike(documentFiles.originalName, '%.odp'),
                ilike(documentFiles.originalName, '%.ods'),
                ilike(documentFiles.originalName, '%.rtf'),
              ),
            ),
          ),
        ),
      ),
    )
    .limit(limit);
}
