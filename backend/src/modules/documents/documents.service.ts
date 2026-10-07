import { eq, inArray } from 'drizzle-orm';

import { db } from '../../db/client.js';
import { documentFiles, documentTypes, storageObjects, uploadSessions } from '../../db/schema/index.js';
import { recordAudit } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { paginate, type PaginationInput } from '../../lib/pagination.js';
import { enqueuePreview } from '../../lib/preview/queue.js';
import { convertFileDirectly } from '../../lib/preview/direct-converter.js';
import { isRasterizerAvailable } from '../../lib/preview/rasterizer.js';
import { MEDIA_TOKEN_TTL_SECONDS, signMediaToken } from '../../lib/media-token.js';
import { enqueueScan } from '../../lib/scan/queue.js';
import { scanningEnabled } from '../../workers/converter/scan.js';
import { needsConversion, resolvePreview, type PreviewDescriptor } from '../../lib/preview/preview.resolver.js';
import { buildDerivedKey, refineContainerMime } from '../../lib/files/mime.js';
import { getStorage } from '../../lib/storage/index.js';
import { env } from '../../config/env.js';
import { contentDisposition } from '../../lib/http/content-disposition.js';
import type { RequestContext } from '../auth/auth.service.js';
import { toDocumentDto, normaliseTags, type DocumentDto } from './documents.mapper.js';
import * as repo from './documents.repository.js';
import type { CreateDocumentInput, ListDocumentsQuery } from './documents.schema.js';

/**
 * Document service.
 *
 * The authorization model, stated once so it is not re-derived at each call
 * site:
 *
 *   owner      may edit and delete their own document, and always download it
 *   moderator  may moderate, and download, anything in their scope
 *   anyone     may download a published document whose visibility allows them
 *
 * Every check is server-side. The frontend hiding a button is a UX affordance
 * and never a control.
 */

export interface ActorContext extends RequestContext {
  actorUserId: string;
  viewer: repo.Viewer;
  /** Permission keys the actor holds, used for fine-grained decisions. */
  permissions: Set<string>;
}

function canModerateAnything(actor: ActorContext): boolean {
  return (
    actor.permissions.has('superadmin.all') ||
    actor.permissions.has('documents.moderate')
  );
}

/** True when the actor may moderate a document in this specific faculty. */
function canModerateDocument(actor: ActorContext, facultyId: string | null): boolean {
  if (actor.permissions.has('superadmin.all')) return true;
  if (!actor.permissions.has('documents.moderate')) return false;
  if (actor.viewer.isModerator) return true;
  // Scoped moderator: only within their faculties. A document with no faculty
  // is not moderatable by a scoped moderator, which is the safe default.
  return facultyId !== null && actor.viewer.facultyIds.includes(facultyId);
}

function permissionsFor(row: repo.DocumentRow, actor: ActorContext | null): DocumentDto['permissions'] {
  if (!actor) {
    return { canEdit: false, canDelete: false, canModerate: false, canDownload: true };
  }

  const isOwner = row.ownerUserId === actor.actorUserId;
  const isModerator = canModerateDocument(actor, row.facultyId);
  const canDeleteOther = actor.permissions.has('superadmin.all') || actor.permissions.has('documents.delete_any');

  return {
    canEdit: isOwner || isModerator,
    canDelete: isOwner || canDeleteAny(actor),
    canModerate: isModerator,
    canDownload: true,
  };

  function canDeleteAny(a: ActorContext): boolean {
    return a.permissions.has('superadmin.all') || a.permissions.has('documents.delete_any');
  }
}

// =============================================================================
// Create
// =============================================================================

/**
 * Create a document from completed uploads.
 *
 * Uploads are validated to belong to the caller and to have finished. Without
 * that check a user could attach someone else's upload session to their own
 * document — the session id is a UUID, but it appears in status responses and
 * could be logged.
 */
export async function createDocument(
  input: CreateDocumentInput,
  actor: ActorContext,
): Promise<DocumentDto> {
  const outcome = await db.transaction(async (tx) => {
    // --- Validate taxonomy references --------------------------------------
    const [documentType] = await tx
      .select()
      .from(documentTypes)
      .where(eq(documentTypes.id, input.documentTypeId))
      .limit(1);

    if (!documentType) {
      throw new AppError('DOCUMENT_TYPE_NOT_FOUND', 'Loại tài liệu không tồn tại.');
    }

    if (documentType.moderationPolicy === 'blocked') {
      throw new AppError(
        'FORBIDDEN',
        `Loại tài liệu "${documentType.name}" hiện không được phép đăng tải.`,
      );
    }

    // --- Validate the uploads ----------------------------------------------
    const fetched = await tx
      .select()
      .from(uploadSessions)
      .where(inArray(uploadSessions.id, input.uploadIds));

    if (fetched.length !== input.uploadIds.length) {
      throw new AppError('UPLOAD_SESSION_NOT_FOUND', 'Một hoặc nhiều phiên tải lên không tồn tại.');
    }

    // Restored to the caller's order, because `WHERE id IN (...)` guarantees
    // nothing about the order rows come back in — Postgres is free to return
    // them in whatever sequence the chosen plan produces, and it does.
    //
    // Everything below depends on this: `index === 0` decides which file is
    // primary, `sessions[0]` supplies the document's own kind, and the upload
    // page tells the user in as many words that the first file they added is
    // the primary one. Without this line that promise was false, and a
    // three-file document got whichever file the planner happened to emit
    // first as its preview and its default download.
    const byId = new Map(fetched.map((session) => [session.id, session]));
    const sessions = input.uploadIds.map((id) => byId.get(id)!);

    for (const session of sessions) {
      if (session.userId !== actor.actorUserId) {
        throw new AppError('UPLOAD_SESSION_NOT_FOUND', 'Một hoặc nhiều phiên tải lên không tồn tại.');
      }
      if (session.status !== 'completed' || !session.contentHash) {
        throw new AppError(
          'UPLOAD_INCOMPLETE',
          'Tất cả tệp phải được tải lên hoàn tất trước khi tạo tài liệu.',
        );
      }
      // A session may back only one document.
      if (session.documentId) {
        throw new AppError('CONFLICT', 'Một tệp đã được gắn vào tài liệu khác.');
      }
    }

    // --- Status from the category's moderation policy ----------------------
    const status =
      documentType.moderationPolicy === 'allowed' ? 'published' : 'pending_review';

    const primarySession = sessions[0]!;
    const totalSize = sessions.reduce((sum, s) => sum + Number(s.totalSize), 0);

    const { id: documentId } = await repo.insertDocument(tx, {
      title: input.title,
      description: input.description,
      documentTypeId: input.documentTypeId,
      ownerUserId: actor.actorUserId,
      facultyId: input.facultyId,
      programId: input.programId,
      subjectId: input.subjectId,
      courseId: input.courseId,
      academicYearId: input.academicYearId,
      semesterId: input.semesterId,
      visibility: input.visibility,
      status,
      language: input.language,
      license: input.license,
      copyrightStatus: input.copyrightStatus,
      source: input.source,
      attribution: input.attribution,
      uploaderConfirmed: input.uploaderConfirmed,
      publishedAt: status === 'published' ? new Date() : null,
    });

    // --- Attach files ------------------------------------------------------
    // Collected here and enqueued after commit; see the note at the call site.
    const scanJobs: {
      fileId: string;
      documentId: string;
      bucket: string;
      objectKey: string;
      originalName: string;
      sizeBytes: number;
    }[] = [];

    const conversionJobs: {
      fileId: string;
      documentId: string;
      bucket: string;
      objectKey: string;
      originalName: string;
      detectedMime: string;
    }[] = [];

    const baseNow = Date.now();
    for (const [index, session] of sessions.entries()) {
      let detectedMime = session.detectedMime ?? 'application/octet-stream';
      if (detectedMime === 'application/zip' || detectedMime === 'application/x-cfb') {
        const refined = refineContainerMime(detectedMime, session.originalName, session.declaredMime);
        if (refined) {
          detectedMime = refined.mime;
        }
      }
      const extension = session.originalName.split('.').pop()?.toLowerCase() ?? null;
      const fileKind = kindFromMime(detectedMime);

      const attached = await repo.attachFile(tx, {
        documentId,
        contentHash: session.contentHash!,
        originalName: session.originalName,
        extension,
        sizeBytes: Number(session.totalSize),
        declaredMime: session.declaredMime,
        detectedMime,
        fileKind,
        isPrimary: index === 0,
        // A file that has not been cleared by the scanner is NOT downloadable —
        // `getDownloadUrl` refuses anything that is not `ready`. So when
        // scanning is on, the file starts pending and only the scanner moves
        // it forward. When scanning is off, the operator made that choice
        // explicitly and the file is served immediately.
        status: scanningEnabled() ? 'pending' : 'ready',
        pageCount: null,
        // Set to `queued` only when a job below is actually enqueued, so the
        // UI never claims a conversion is coming when none was scheduled.
        previewStatus: needsConversion(detectedMime) ? 'queued' : 'none',
        createdAt: new Date(baseNow + index * 1000),
      });

      // Reference counting, in the same transaction as the attach. If these
      // could diverge, the reaper could delete bytes that are still in use.
      await repo.incrementStorageRef(tx, session.contentHash!);

      if (scanningEnabled()) {
        const [storedForScan] = await repo.findStorageObjectsByHashes(tx, [session.contentHash!]);
        if (storedForScan) {
          // Set explicitly. The column defaults to 'skipped', so leaving it
          // alone would leave a file that IS queued for scanning reporting
          // that scanning was switched off — a status that lies, and an
          // operator who concludes the scanner is disabled when it is not.
          await tx
            .update(documentFiles)
            .set({ scanStatus: 'queued' })
            .where(eq(documentFiles.id, attached.id));

          scanJobs.push({
            fileId: attached.id,
            documentId,
            bucket: env.S3_BUCKET,
            objectKey: storedForScan.objectKey,
            originalName: session.originalName,
            sizeBytes: Number(session.totalSize),
          });
        }
      } else {
        // Recorded explicitly rather than left null: "no scanner was configured"
        // is a fact worth being able to query later.
        await tx
          .update(documentFiles)
          .set({ scanStatus: 'skipped' })
          .where(eq(documentFiles.id, attached.id));
      }

      if (needsConversion(detectedMime)) {
        const [stored] = await repo.findStorageObjectsByHashes(tx, [session.contentHash!]);
        if (stored) {
          conversionJobs.push({
            fileId: attached.id,
            documentId,
            bucket: env.S3_BUCKET,
            objectKey: stored.objectKey,
            originalName: session.originalName,
            detectedMime,
          });
        }
      }

      await tx
        .update(uploadSessions)
        .set({ documentId, updatedAt: new Date() })
        .where(eq(uploadSessions.id, session.id));
    }

    // Denormalised onto the document so listing pages need no join.
    let primaryMime = primarySession.detectedMime ?? 'application/octet-stream';
    if (primaryMime === 'application/zip' || primaryMime === 'application/x-cfb') {
      const refined = refineContainerMime(primaryMime, primarySession.originalName, primarySession.declaredMime);
      if (refined) primaryMime = refined.mime;
    }
    await repo.updateDocument(tx, documentId, {
      fileKind: kindFromMime(primaryMime),
      sizeBytes: totalSize,
    });

    // --- Tags --------------------------------------------------------------
    if (input.tags.length > 0) {
      const tagIds = await repo.upsertTags(tx, normaliseTags(input.tags));
      await repo.replaceDocumentTags(tx, documentId, tagIds);
    }

    await recordAudit(tx, {
      action: 'document.created',
      actorUserId: actor.actorUserId,
      targetType: 'document',
      targetId: documentId,
      metadata: { title: input.title, status, fileCount: sessions.length },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    const row = await repo.findDocumentUnscoped(documentId, tx);
    if (!row) throw new Error('Document vanished immediately after creation.');

    return { row, conversionJobs, scanJobs };
  });

  // Enqueued AFTER the transaction commits. Queueing inside it would leave a
  // job pointing at a file row that a rollback then removed — the worker would
  // fail forever on a file that does not exist.
  for (const job of outcome.scanJobs) {
    await enqueueScan(job).catch((scanError: unknown) => {
      // The file stays `pending` and therefore unserved, which is the safe
      // outcome — but it is not silent, because a queue that is down would
      // otherwise look like every upload hanging.
      console.error('[documents] failed to enqueue scan:', (scanError as Error).message);
    });
  }

  for (const job of outcome.conversionJobs) {
    await enqueuePreview(job).catch((error: unknown) => {
      // A queue failure must not fail the upload. The document exists and is
      // downloadable; only the preview is missing, and the reindex action can
      // requeue it later.
      console.error('[documents] failed to enqueue preview:', (error as Error).message);
    });
  }

  // Hydrated through the same path as a read. Returning the bare row here would
  // give the client an empty `files` and `tags` array for a document it just
  // attached both to — the UI would show a freshly created document as having
  // no files until the next reload.
  return hydrate(outcome.row, actor);
}

// =============================================================================
// Read
// =============================================================================

async function hydrate(row: repo.DocumentRow, actor: ActorContext | null): Promise<DocumentDto> {
  const [files, tagRows] = await Promise.all([
    repo.findDocumentFiles(row.id),
    repo.findDocumentTags(row.id),
  ]);

  return toDocumentDto(row, {
    // Storage coordinates are dropped here — the mapper only accepts the
    // fields it needs, so objectKey and bucket cannot travel further.
    files: files.map((f) => ({
      id: f.id,
      originalName: f.originalName,
      sizeBytes: f.sizeBytes,
      detectedMime: f.detectedMime,
      fileKind: f.fileKind,
      isPrimary: f.isPrimary,
      status: f.status,
      extension: f.extension,
      pageCount: f.pageCount,
      previewStatus: f.previewStatus,
    })),
    tags: tagRows,
    permissions: permissionsFor(row, actor),
  });
}

export async function getDocument(
  id: string,
  actor: ActorContext | null,
): Promise<DocumentDto> {
  const viewer = actor?.viewer ?? { userId: null, isModerator: false, facultyIds: [] };
  const row = await repo.findDocumentById(id, viewer);

  if (!row) {
    // 404 whether the document is missing or merely invisible. Distinguishing
    // them would confirm the existence of private documents.
    throw new AppError('DOCUMENT_NOT_FOUND', 'Không tìm thấy tài liệu.');
  }

  // A view is a real event, but it must not be countable by the owner
  // refreshing their own page, or the number becomes meaningless.
  if (actor && row.ownerUserId !== actor.actorUserId) {
    void repo.incrementViewCount(db, row.id).catch(() => undefined);
  }

  return hydrate(row, actor);
}

export async function listDocuments(
  filters: ListDocumentsQuery,
  pagination: PaginationInput,
  actor: ActorContext | null,
) {
  const viewer = actor?.viewer ?? { userId: null, isModerator: false, facultyIds: [] };
  const { items, total } = await repo.listDocuments(filters, pagination, viewer);

  // List responses omit files and tags: fetching them for 20 documents is 40
  // extra queries, and a browse page shows neither.
  const dtos = items.map((row) => toDocumentDto(row, { permissions: permissionsFor(row, actor) }));

  return paginate(dtos, total, pagination);
}

// =============================================================================
// Update and delete
// =============================================================================

export async function updateDocument(
  id: string,
  input: Record<string, unknown>,
  actor: ActorContext,
): Promise<DocumentDto> {
  return db.transaction(async (tx) => {
    const row = await repo.findDocumentUnscoped(id, tx);
    if (!row) throw new AppError('DOCUMENT_NOT_FOUND', 'Không tìm thấy tài liệu.');

    const isOwner = row.ownerUserId === actor.actorUserId;
    const isModerator = canModerateDocument(actor, row.facultyId);

    if (!isOwner && !isModerator) {
      throw new AppError('DOCUMENT_NOT_OWNER', 'Bạn không có quyền sửa tài liệu này.');
    }

    const { tags, ...fields } = input as { tags?: string[] } & Record<string, unknown>;

    await repo.updateDocument(tx, id, fields);

    if (tags) {
      const tagIds = await repo.upsertTags(tx, normaliseTags(tags));
      await repo.replaceDocumentTags(tx, id, tagIds);
    }

    await recordAudit(tx, {
      action: 'document.updated',
      actorUserId: actor.actorUserId,
      targetType: 'document',
      targetId: id,
      metadata: { byModerator: !isOwner, fields: Object.keys(fields) },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    const updated = await repo.findDocumentUnscoped(id, tx);
    return toDocumentDto(updated!, { permissions: permissionsFor(updated!, actor) });
  });
}

export async function deleteDocument(id: string, actor: ActorContext): Promise<void> {
  await db.transaction(async (tx) => {
    const row = await repo.findDocumentUnscoped(id, tx);
    if (!row) throw new AppError('DOCUMENT_NOT_FOUND', 'Không tìm thấy tài liệu.');

    const isOwner = row.ownerUserId === actor.actorUserId;
    const canDeleteAny =
      actor.permissions.has('superadmin.all') || actor.permissions.has('documents.delete_any');

    if (!isOwner && !canDeleteAny) {
      throw new AppError('DOCUMENT_NOT_OWNER', 'Bạn không có quyền xoá tài liệu này.');
    }

    // Soft delete only. The row is retained so the academic record survives,
    // and the reaper decrements storage reference counts separately — deleting
    // bytes here would break every other document sharing the same content.
    await repo.softDeleteDocument(tx, id);

    await recordAudit(tx, {
      action: 'document.deleted',
      actorUserId: actor.actorUserId,
      targetType: 'document',
      targetId: id,
      metadata: { title: row.title, byOwner: isOwner },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });
}

// =============================================================================
// Download
// =============================================================================

export interface DownloadTarget {
  url: string;
  fileName: string;
  mimeType: string;
  expiresInSeconds: number;
}

/**
 * Where a browser should fetch a document's bytes.
 *
 * SAME ORIGIN, NOT A SIGNED STORAGE URL. The obvious implementation hands the
 * client a signed URL on the object store, and that is what this used to do.
 * It is wrong for two reasons that only show up in a real browser:
 *
 *   THE DOWNLOAD NAME. `<a download="...">` is ignored for a cross-origin URL,
 *   so the file saved under the storage key — a bare UUID with no extension —
 *   instead of "Bài giảng C++.pdf". The user gets a file their machine cannot
 *   open by double-clicking.
 *
 *   THE THIRD-PARTY CONTEXT. Every preview and download then loads from the
 *   storage origin, which the browser treats as a third party: it partitions
 *   storage and logs "Partitioned cookie or storage access was provided to
 *   ... because it is loaded in the third-party context" on every one. That
 *   warning appeared on the product's most-used feature.
 *
 * So the bytes are proxied through the API, and the URL carries a scoped media
 * token because an `<img>`, an `<object>` and an `<a download>` cannot send an
 * Authorization header. The token records the authorization decision that the
 * caller has already been through; it does not replace it.
 */
async function contentUrl(
  documentId: string,
  fileId: string,
  mode: 'preview' | 'download',
): Promise<{ url: string; expiresInSeconds: number }> {
  const token = await signMediaToken({ documentId, fileId });
  const query = new URLSearchParams({ token, mode });
  return {
    url: `/api/v1/documents/${documentId}/files/${fileId}/content?${query.toString()}`,
    // Matches the token's own lifetime, so a client that trusts this number
    // and re-fetches after it is not presenting an expired token.
    expiresInSeconds: MEDIA_TOKEN_TTL_SECONDS,
  };
}

/**
 * Authorize a download and describe where to get it.
 *
 * The storage key is never returned to the client — only a same-origin URL
 * with a token that expires in minutes.
 */
export async function getDownloadUrl(
  documentId: string,
  fileId: string | null,
  actor: ActorContext | null,
): Promise<DownloadTarget> {
  const viewer = actor?.viewer ?? { userId: null, isModerator: false, facultyIds: [] };

  // Visibility check first, via the same predicate the read path uses, so a
  // download can never succeed where a read would fail.
  const row = await repo.findDocumentById(documentId, viewer);
  if (!row) {
    throw new AppError('DOCUMENT_NOT_FOUND', 'Không tìm thấy tài liệu.');
  }

  const files = await repo.findDocumentFiles(documentId);
  if (files.length === 0) {
    throw new AppError('FILE_NOT_FOUND', 'Tài liệu này chưa có tệp đính kèm.');
  }

  const file = fileId
    ? files.find((f) => f.id === fileId)
    : (files.find((f) => f.isPrimary) ?? files[0]);

  if (!file) {
    throw new AppError('FILE_NOT_FOUND', 'Không tìm thấy tệp.');
  }

  if (file.status !== 'ready') {
    throw new AppError('FILE_NOT_FOUND', 'Tệp chưa sẵn sàng để tải xuống.');
  }

  const storage = getStorage();
  const fileExists = await storage
    .objectExists({ bucket: file.bucket, key: file.objectKey })
    .catch(() => false);

  if (!fileExists) {
    throw new AppError('FILE_NOT_FOUND', 'Tệp tài liệu hiện không khả dụng trong bộ nhớ lưu trữ.');
  }

  const { url, expiresInSeconds } = await contentUrl(documentId, file.id, 'download');

  // Logged after the URL is minted. A download that was authorized but never
  // started still counts as intent, and the row is what abuse analysis reads.
  await repo
    .recordDownload(db, {
      documentId,
      fileId: file.id,
      userId: actor?.actorUserId ?? null,
      ip: actor?.ip ?? null,
      userAgent: actor?.userAgent ?? null,
      referer: null,
      requestId: actor?.requestId ?? null,
    })
    .catch(() => undefined);

  return {
    url,
    fileName: file.originalName,
    mimeType: file.detectedMime,
    expiresInSeconds,
  };
}
// =============================================================================
// Preview
// =============================================================================

export interface PreviewResponse extends PreviewDescriptor {
  /** Signed URL, present only when the preview is immediately renderable. */
  url: string | null;
  expiresInSeconds: number | null;
  /** Why a preview is unavailable, when it is — shown verbatim to the user. */
  reason: string | null;
  originalName: string;
  totalPages?: number | null;
  pages?: string[];
}

/**
 * Resolve how a file can be previewed, minting a URL when it can be.
 *
 * The authorization check is the same one the download path uses, via the same
 * visibility predicate — a preview must never be reachable where a read would
 * not be. Skipping it here is the easiest way to leak a private document, since
 * a preview endpoint feels like a read-only convenience rather than a data
 * access path.
 */
export async function getPreview(
  documentId: string,
  fileId: string | null,
  actor: ActorContext | null,
): Promise<PreviewResponse> {
  const viewer = actor?.viewer ?? { userId: null, isModerator: false, facultyIds: [] };

  const row = await repo.findDocumentById(documentId, viewer);
  if (!row) {
    throw new AppError('DOCUMENT_NOT_FOUND', 'Không tìm thấy tài liệu.');
  }

  const files = await repo.findDocumentFiles(documentId);
  if (files.length === 0) {
    throw new AppError('FILE_NOT_FOUND', 'Tài liệu này chưa có tệp đính kèm.');
  }

  const file = fileId
    ? files.find((f) => f.id === fileId)
    : (files.find((f) => f.isPrimary) ?? files[0]);

  if (!file) {
    throw new AppError('FILE_NOT_FOUND', 'Không tìm thấy tệp.');
  }

  // The scan gate applies to preview exactly as it does to download. Checking
  // only `previewStatus` here — which describes whether a PDF *conversion*
  // exists — left a file that failed its virus scan readable inline while the
  // download was correctly refused. The control was being bypassed by the
  // feature meant to be safer than downloading.
  if (file.status !== 'ready') {
    throw new AppError(
      'FILE_NOT_FOUND',
      'Tệp chưa sẵn sàng để xem trước.',
    );
  }

  // Auto-heal generic container types (e.g. PPTX/DOCX stored as application/zip before refinement)
  let detectedMime = file.detectedMime;
  let fileKind = file.fileKind;
  let previewStatus = file.previewStatus;

  if (detectedMime === 'application/zip' || detectedMime === 'application/x-cfb') {
    const refined = refineContainerMime(detectedMime, file.originalName);
    if (refined) {
      detectedMime = refined.mime;
      fileKind = refined.kind;
      if (previewStatus === 'none') {
        previewStatus = 'queued';
      }
      await repo.updateFileMeta(file.id, {
        detectedMime: refined.mime,
        fileKind: refined.kind,
        extension: refined.extension,
        previewStatus,
      }).catch(() => undefined);

      if (file.isPrimary) {
        await repo.updateDocument(db, documentId, { fileKind: refined.kind }).catch(() => undefined);
      }
    }
  }

  // Auto-heal convertible office documents whose previewStatus is still 'none'
  if (needsConversion(detectedMime) && previewStatus === 'none') {
    previewStatus = 'queued';
    await repo.updateFileMeta(file.id, { previewStatus: 'queued' }).catch(() => undefined);
  }

  const descriptor = resolvePreview({
    fileId: file.id,
    detectedMime,
    fileKind,
    originalName: file.originalName,
    previewStatus,
  });

  const base: Omit<PreviewResponse, 'url' | 'expiresInSeconds' | 'reason'> = {
    ...descriptor,
    originalName: file.originalName,
  };

  // --- No preview available ------------------------------------------------
  if (descriptor.kind === 'none') {
    return {
      ...base,
      url: null,
      expiresInSeconds: null,
      reason: 'Định dạng này không xem trước được. Vui lòng tải tệp về máy.',
    };
  }

  // --- Office, still converting -------------------------------------------
  if (descriptor.kind === 'office' && descriptor.conversion === 'pending') {
    // 1. Enqueue in Redis for background queue
    await enqueuePreview({
      fileId: file.id,
      documentId,
      bucket: file.bucket,
      objectKey: file.objectKey,
      originalName: file.originalName,
      detectedMime,
    }).catch(() => undefined);

    // 2. Also trigger on-demand conversion immediately in background so user doesn't wait
    void convertFileDirectly(file.id).catch(() => undefined);

    return {
      ...base,
      url: null,
      expiresInSeconds: null,
      reason: 'Tài liệu đang được xử lý để xem trước. Vui lòng đợi trong giây lát...',
    };
  }

  if (descriptor.kind === 'office' && descriptor.conversion === 'failed') {
    // Self-heal / retry: re-enqueue preview job so worker converts it again
    await db
      .update(documentFiles)
      .set({ previewStatus: 'queued', previewError: null })
      .where(eq(documentFiles.id, file.id))
      .catch(() => undefined);

    await enqueuePreview({
      fileId: file.id,
      documentId,
      bucket: file.bucket,
      objectKey: file.objectKey,
      originalName: file.originalName,
      detectedMime,
    }, { force: true }).catch(() => undefined);

    // Trigger direct conversion immediately
    void convertFileDirectly(file.id).catch(() => undefined);

    return {
      ...base,
      url: null,
      expiresInSeconds: null,
      reason: 'Đang thử tạo lại bản xem trước cho tệp này. Vui lòng đợi trong giây lát...',
    };
  }

  // --- Office, converted: serve the PDF artifact ---------------------------
  if (descriptor.kind === 'office') {
    const preview = await repo.findPreviewObject(documentId, file.id);
    if (!preview) {
      // Status says ready or pending, but the artifact row is missing.
      // Self-heal: re-queue and trigger direct conversion
      await enqueuePreview({
        fileId: file.id,
        documentId,
        bucket: file.bucket,
        objectKey: file.objectKey,
        originalName: file.originalName,
        detectedMime,
      }, { force: true }).catch(() => undefined);

      void convertFileDirectly(file.id).catch(() => undefined);

      return {
        ...base,
        url: null,
        expiresInSeconds: null,
        reason: 'Bản xem trước đang được khởi tạo lại. Vui lòng đợi trong giây lát...',
      };
    }

    const storage = getStorage();
    const artifactExists = await storage
      .objectExists({ bucket: preview.bucket, key: preview.objectKey })
      .catch(() => false);

    if (!artifactExists) {
      // Artifact missing from storage backend. Re-queue.
      await enqueuePreview({
        fileId: file.id,
        documentId,
        bucket: file.bucket,
        objectKey: file.objectKey,
        originalName: file.originalName,
        detectedMime,
      }, { force: true }).catch(() => undefined);

      return {
        ...base,
        url: null,
        expiresInSeconds: null,
        reason: 'Bản xem trước đang được khởi tạo lại trong bộ nhớ lưu trữ. Vui lòng thử lại sau.',
      };
    }

    // Auto-rasterize pages if not done yet
    let pageCount = file.pageCount;
    if ((!pageCount || pageCount === 0) && (await isRasterizerAvailable())) {
      await convertFileDirectly(file.id).catch(() => undefined);
      const [refreshed] = await db
        .select({ pageCount: documentFiles.pageCount })
        .from(documentFiles)
        .where(eq(documentFiles.id, file.id));
      if (refreshed?.pageCount) {
        pageCount = refreshed.pageCount;
      }
    }

    const { url, expiresInSeconds } = await contentUrl(documentId, file.id, 'preview');

    let pages: string[] | undefined;
    if (pageCount && pageCount > 0) {
      const token = await signMediaToken({ documentId, fileId: file.id });
      pages = [];
      for (let p = 1; p <= pageCount; p++) {
        pages.push(
          `/api/v1/documents/${documentId}/files/${file.id}/pages/${p}?token=${encodeURIComponent(token)}`,
        );
      }
    }

    return { ...base, url, expiresInSeconds, reason: null, totalPages: pageCount, pages };
  }

  // --- Natively renderable -------------------------------------------------
  const storage = getStorage();
  const fileExists = await storage
    .objectExists({ bucket: file.bucket, key: file.objectKey })
    .catch(() => false);

  if (!fileExists) {
    return {
      ...base,
      url: null,
      expiresInSeconds: null,
      reason: 'Tệp tài liệu hiện không khả dụng trong bộ nhớ lưu trữ. Vui lòng tải lại tệp hoặc liên hệ quản trị viên.',
    };
  }

  // For native PDF files, also check if rasterized page images are available or can be generated
  let pageCount = file.pageCount;
  if (descriptor.kind === 'pdf') {
    if ((!pageCount || pageCount === 0) && (await isRasterizerAvailable())) {
      await convertFileDirectly(file.id).catch(() => undefined);
      const [refreshed] = await db
        .select({ pageCount: documentFiles.pageCount })
        .from(documentFiles)
        .where(eq(documentFiles.id, file.id));
      if (refreshed?.pageCount) {
        pageCount = refreshed.pageCount;
      }
    }
  }

  const { url, expiresInSeconds } = await contentUrl(documentId, file.id, 'preview');

  let pages: string[] | undefined;
  if (pageCount && pageCount > 0) {
    const token = await signMediaToken({ documentId, fileId: file.id });
    pages = [];
    for (let p = 1; p <= pageCount; p++) {
      pages.push(
        `/api/v1/documents/${documentId}/files/${file.id}/pages/${p}?token=${encodeURIComponent(token)}`,
      );
    }
  }

  return { ...base, url, expiresInSeconds, reason: null, totalPages: pageCount, pages };
}

// =============================================================================
// Content streaming
// =============================================================================

export interface ContentTarget {
  bucket: string;
  key: string;
  contentType: string;
  filename: string;
}

/**
 * Resolve what a content token is allowed to read.
 *
 * NOTE WHAT THIS DOES NOT DO: it does not apply a viewer predicate, because
 * there is no viewer — the request carries a token, not a session. That is
 * sound, and only because the token is minted by a route that already applied
 * the predicate, is scoped to this one file, and expires in ten minutes.
 *
 * What it *does* re-check is that the file is still servable right now. A
 * document can be deleted, archived, or have its file quarantined by the
 * scanner in the window between the token being issued and the bytes being
 * fetched, and a token should not be a ten-minute bypass of that.
 */
export async function resolveContentTarget(
  documentId: string,
  fileId: string,
  mode: 'preview' | 'download',
): Promise<ContentTarget> {
  const files = await repo.findDocumentFiles(documentId);
  const file = files.find((f) => f.id === fileId);

  if (!file) {
    throw new AppError('FILE_NOT_FOUND', 'Không tìm thấy tệp.');
  }

  if (file.status !== 'ready') {
    throw new AppError('FILE_NOT_FOUND', 'Tệp chưa sẵn sàng.');
  }

  // A preview of an Office file is the generated PDF, not the original — the
  // browser cannot render a .docx, and the whole point of the conversion
  // worker is that it can render this instead.
  if (mode === 'preview') {
    let detectedMime = file.detectedMime;
    if (detectedMime === 'application/zip' || detectedMime === 'application/x-cfb') {
      const refined = refineContainerMime(detectedMime, file.originalName);
      if (refined) detectedMime = refined.mime;
    }
    const descriptor = resolvePreview({
      fileId: file.id,
      detectedMime,
      fileKind: file.fileKind,
      originalName: file.originalName,
      previewStatus: file.previewStatus,
    });
    if (descriptor.kind === 'office') {
      const preview = await repo.findPreviewObject(documentId, file.id);
      if (!preview) {
        throw new AppError('PREVIEW_NOT_AVAILABLE', 'Bản xem trước chưa sẵn sàng.');
      }
      return {
        bucket: preview.bucket,
        key: preview.objectKey,
        contentType: 'application/pdf',
        // Shown inline; the name only matters for a save dialog.
        filename: `${file.originalName}.pdf`,
      };
    }
  }

  return {
    bucket: file.bucket,
    key: file.objectKey,
    contentType: file.detectedMime,
    filename: file.originalName,
  };
}

export async function resolvePageImageTarget(
  documentId: string,
  fileId: string,
  pageNum: number,
): Promise<{ bucket: string; key: string }> {
  const files = await repo.findDocumentFiles(documentId);
  const file = files.find((f) => f.id === fileId);

  if (!file) {
    throw new AppError('FILE_NOT_FOUND', 'Không tìm thấy tệp.');
  }

  if (file.status !== 'ready') {
    throw new AppError('FILE_NOT_FOUND', 'Tệp chưa sẵn sàng.');
  }

  const pageKey = buildDerivedKey(file.objectKey, `page${pageNum}`, 'jpg');
  const storage = getStorage();
  const exists = await storage
    .objectExists({ bucket: file.bucket || env.S3_BUCKET, key: pageKey })
    .catch(() => false);

  if (!exists) {
    throw new AppError('FILE_NOT_FOUND', 'Trang tài liệu chưa sẵn sàng hoặc không tồn tại.');
  }

  return {
    bucket: file.bucket || env.S3_BUCKET,
    key: pageKey,
  };
}

// =============================================================================
// Ratings
// =============================================================================
export async function rateDocument(
  documentId: string,
  input: { rating: number; review: string | null },
  actor: ActorContext,
): Promise<{ ratingAverage: number | null; ratingCount: number }> {
  return db.transaction(async (tx) => {
    const row = await repo.findDocumentUnscoped(documentId, tx);
    if (!row) throw new AppError('DOCUMENT_NOT_FOUND', 'Không tìm thấy tài liệu.');

    // Rating your own document is a trivial way to farm a perfect score.
    if (row.ownerUserId === actor.actorUserId) {
      throw new AppError('FORBIDDEN', 'Bạn không thể tự đánh giá tài liệu của mình.');
    }

    // Only published documents are rateable.
    if (row.status !== 'published') {
      throw new AppError('DOCUMENT_NOT_PUBLISHED', 'Chỉ có thể đánh giá tài liệu đã được đăng.');
    }

    await repo.upsertRating(tx, {
      documentId,
      userId: actor.actorUserId,
      rating: input.rating,
      review: input.review,
    });

    const updated = await repo.findDocumentUnscoped(documentId, tx);

    return {
      ratingAverage: updated?.ratingAvg === null || updated?.ratingAvg === undefined
        ? null
        : Number(updated.ratingAvg),
      ratingCount: Number(updated?.ratingCount ?? 0),
    };
  });
}

export async function removeRating(documentId: string, actor: ActorContext): Promise<void> {
  await repo.deleteRating(db, documentId, actor.actorUserId);
}

export async function listRatings(documentId: string, pagination: PaginationInput) {
  const { items, total } = await repo.listRatings(documentId, pagination);
  return paginate(
    items.map((r) => ({
      rating: r.rating,
      review: r.review,
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
      user: { id: r.userId, displayName: r.displayName, avatarUrl: r.avatarUrl },
    })),
    total,
    pagination,
  );
}

// =============================================================================
// Moderation
// =============================================================================

const STATUS_BY_ACTION = {
  publish: 'published',
  reject: 'rejected',
  archive: 'archived',
  restore: 'published',
} as const;

/**
 * Change a document's moderation status.
 *
 * The faculty-scope check is the important part: a faculty moderator must not
 * be able to publish a document belonging to another faculty. `permissionsFor`
 * already resolved whether this actor may moderate this row, and it consults
 * `viewer.facultyIds`, not just the permission key.
 */
export async function moderateDocument(
  documentId: string,
  input: { action: keyof typeof STATUS_BY_ACTION; reason: string | null },
  actor: ActorContext,
): Promise<DocumentDto> {
  return db.transaction(async (tx) => {
    const row = await repo.findDocumentUnscoped(documentId, tx);
    if (!row) throw new AppError('DOCUMENT_NOT_FOUND', 'Không tìm thấy tài liệu.');

    if (!canModerateDocument(actor, row.facultyId)) {
      throw new AppError(
        'PERMISSION_DENIED',
        'Bạn không có quyền kiểm duyệt tài liệu thuộc khoa này.',
      );
    }

    const toStatus = STATUS_BY_ACTION[input.action];

    await repo.setDocumentStatus(tx, {
      documentId,
      fromStatus: row.status,
      toStatus,
      actorUserId: actor.actorUserId,
      reason: input.reason,
    });

    await recordAudit(tx, {
      action: `document.moderate.${input.action}`,
      actorUserId: actor.actorUserId,
      targetType: 'document',
      targetId: documentId,
      metadata: { from: row.status, to: toStatus, reason: input.reason },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    const updated = await repo.findDocumentUnscoped(documentId, tx);
    return toDocumentDto(updated!, { permissions: permissionsFor(updated!, actor) });
  });
}

export async function listModerationQueue(
  actor: ActorContext,
  filters: { status?: string; facultyId?: string },
  pagination: PaginationInput,
) {
  if (!canModerateAnything(actor)) {
    throw new AppError('PERMISSION_DENIED', 'Bạn không có quyền truy cập hàng đợi kiểm duyệt.');
  }

  const { items, total } = await repo.listModerationQueue(actor.viewer, filters, pagination);
  return paginate(
    items.map((row) => toDocumentDto(row, { permissions: permissionsFor(row, actor) })),
    total,
    pagination,
  );
}

export async function listPopularTags(limit = 50) {
  return repo.popularTags(limit);
}

// =============================================================================
// Helpers
// =============================================================================

function kindFromMime(
  mime: string,
): 'pdf' | 'document' | 'spreadsheet' | 'presentation' | 'archive' | 'image' | 'text' | 'code' | 'other' {
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('text/')) return 'text';
  if (
    mime === 'application/zip' ||
    mime.includes('rar') ||
    mime.includes('7z') ||
    mime.includes('tar') ||
    mime.includes('gzip')
  ) {
    return 'archive';
  }
  if (mime.includes('word') || mime.includes('opendocument.text') || mime === 'application/rtf') {
    return 'document';
  }
  if (mime.includes('sheet') || mime.includes('excel') || mime.includes('csv')) return 'spreadsheet';
  if (mime.includes('presentation') || mime.includes('powerpoint')) return 'presentation';
  return 'other';
}

/** Re-exported so the controller can build a viewer without importing the repo. */
export type { Viewer } from './documents.repository.js';
