import type { FastifyReply, FastifyRequest } from 'fastify';

import { AppError } from '../../lib/errors.js';
import { streamObject } from '../../lib/http/stream-object.js';
import { verifyMediaToken } from '../../lib/media-token.js';
import { paginationMeta } from '../../lib/pagination.js';
import { parseBody, parseParams, parseQuery } from '../../lib/validation.js';
import { getUserModerationScope, getUserPermissions } from '../rbac/rbac.service.js';
import * as service from './documents.service.js';
import {
  createDocumentSchema,
  documentFileParamSchema,
  documentIdParamSchema,
  listDocumentsQuerySchema,
  moderateDocumentSchema,
  ratingSchema,
  updateDocumentSchema,
} from './documents.schema.js';

/**
 * Documents HTTP layer.
 *
 * The visibility of a document depends on who is asking, so most routes use
 * `optionalAuth` rather than `authenticate`: an anonymous visitor must be able
 * to read a public document, and the service decides what that means. Routes
 * that always require an identity use `authenticate`.
 */

/**
 * Build the actor context the service needs.
 *
 * The moderation scope is what makes faculty-scoped moderation real. It is
 * resolved here and passed down, and the repository applies it in SQL — the
 * service never receives rows a scoped moderator may not act on.
 */
async function buildActor(request: FastifyRequest): Promise<service.ActorContext | null> {
  if (!request.user) return null;

  const [permissions, scope] = await Promise.all([
    getUserPermissions(request.user.id),
    getUserModerationScope(request.user.id),
  ]);

  return {
    actorUserId: request.user.id,
    userAgent: request.headers['user-agent'] ?? null,
    ip: request.ip ?? null,
    requestId: request.id,
    permissions,
    viewer: {
      userId: request.user.id,
      isModerator: scope.global,
      facultyIds: scope.facultyIds,
    },
  };
}

/** Same as `buildActor`, but rejects when there is no identity. */
async function requireActor(request: FastifyRequest): Promise<service.ActorContext> {
  const actor = await buildActor(request);
  if (!actor) {
    throw new AppError('UNAUTHORIZED', 'Authentication is required for this request.');
  }
  return actor;
}

function sendPaginated<T>(
  reply: FastifyReply,
  result: { items: T[]; page: number; limit: number; total: number; totalPages: number },
) {
  return reply.ok(result.items, paginationMeta(result));
}

// =============================================================================

export async function createDocument(request: FastifyRequest, reply: FastifyReply) {
  const actor = await requireActor(request);
  const body = parseBody(createDocumentSchema, request.body);
  const document = await service.createDocument(body, actor);
  reply.status(201);
  return reply.ok(document, {}, 'Đã tạo tài liệu.');
}

export async function listDocuments(request: FastifyRequest, reply: FastifyReply) {
  const actor = await buildActor(request);
  const query = parseQuery(listDocumentsQuerySchema, request.query);
  const result = await service.listDocuments(query, query, actor);
  return sendPaginated(reply, result);
}

export async function getDocument(request: FastifyRequest, reply: FastifyReply) {
  const actor = await buildActor(request);
  const { id } = parseParams(documentIdParamSchema, request.params);
  return reply.ok(await service.getDocument(id, actor));
}

export async function updateDocument(request: FastifyRequest, reply: FastifyReply) {
  const actor = await requireActor(request);
  const { id } = parseParams(documentIdParamSchema, request.params);
  const body = parseBody(updateDocumentSchema, request.body);
  return reply.ok(
    await service.updateDocument(id, body as Record<string, unknown>, actor),
    {},
    'Đã cập nhật tài liệu.',
  );
}

export async function deleteDocument(request: FastifyRequest, reply: FastifyReply) {
  const actor = await requireActor(request);
  const { id } = parseParams(documentIdParamSchema, request.params);
  await service.deleteDocument(id, actor);
  return reply.ok({ deleted: true }, {}, 'Đã xoá tài liệu.');
}

/**
 * Mint a download URL.
 *
 * Responds with the signed URL in the body rather than a 302 redirect. A
 * redirect would have the browser follow it and hide the failure mode: a client
 * that receives a redirect to an expired URL sees a generic storage error page
 * instead of a JSON error it can handle.
 */
export async function downloadDocument(request: FastifyRequest, reply: FastifyReply) {
  const actor = await buildActor(request);
  const { id } = parseParams(documentIdParamSchema, request.params);
  const query = request.query as { fileId?: string };

  const target = await service.getDownloadUrl(id, query.fileId ?? null, actor);

  return reply.ok({
    url: target.url,
    fileName: target.fileName,
    mimeType: target.mimeType,
    expiresInSeconds: target.expiresInSeconds,
  });
}

/**
 * Preview descriptor plus a signed URL when one is available.
 *
 * A separate endpoint from `download` because they answer different questions:
 * download always produces a file, preview may legitimately have nothing to
 * show. Folding them together would force the client to interpret a download
 * response as a failure whenever a format simply has no previewer.
 */
export async function previewDocument(request: FastifyRequest, reply: FastifyReply) {
  const actor = await buildActor(request);
  const { id } = parseParams(documentIdParamSchema, request.params);
  const query = request.query as { fileId?: string };

  return reply.ok(await service.getPreview(id, query.fileId ?? null, actor));
}

/**
 * Serve a document's bytes to the browser.
 *
 * NOT `optionalAuth`, and not `authenticate` either. The caller arrives from an
 * `<img>`, an `<object>` or an `<a download>`, none of which can attach a
 * header, so the authorization decision travels in the `token` query parameter
 * — proof that some earlier request already passed the visibility check.
 *
 * The token is checked against BOTH ids in the path. Without that, a token for
 * a document the caller may read would fetch any other file by editing the URL,
 * which is the whole reason the claims carry a file id rather than the route
 * inferring one.
 */
export async function streamContent(request: FastifyRequest, reply: FastifyReply) {
  const params = request.params as { id?: string; fileId?: string };
  const query = request.query as { token?: string; mode?: string };

  const documentId = params.id ?? '';
  const fileId = params.fileId ?? '';

  if (!query.token) {
    throw new AppError('MEDIA_TOKEN_INVALID', 'Liên kết xem tệp không hợp lệ.');
  }

  const claims = await verifyMediaToken(query.token);

  if (claims.documentId !== documentId || claims.fileId !== fileId) {
    // Deliberately not "wrong file": naming which half mismatched is a hint
    // about what a valid token would look like.
    throw new AppError('MEDIA_TOKEN_INVALID', 'Liên kết xem tệp không hợp lệ.');
  }

  const mode = query.mode === 'download' ? 'download' : 'preview';

  const target = await service.resolveContentTarget(documentId, fileId, mode);

  return streamObject(request, reply, {
    location: { bucket: target.bucket, key: target.key },
    contentType: target.contentType,
    disposition: {
      // A preview is displayed; a download is saved. Sending `attachment` for a
      // preview makes the PDF viewer download the file and show a blank frame,
      // which is the classic "preview does nothing" bug.
      kind: mode === 'download' ? 'attachment' : 'inline',
      filename: target.filename,
    },
    // Never cached by a shared cache: this is one person's authorized document,
    // and the token in the URL would be stored alongside it.
    cacheControl: 'private, no-store',
  });
}

export async function streamPageImage(request: FastifyRequest, reply: FastifyReply) {
  const params = request.params as { id?: string; fileId?: string; pageNum?: string };
  const query = request.query as { token?: string };

  const documentId = params.id ?? '';
  const fileId = params.fileId ?? '';
  const pageNum = parseInt(params.pageNum ?? '1', 10);

  if (isNaN(pageNum) || pageNum < 1 || pageNum > 200) {
    throw new AppError('VALIDATION_FAILED', 'Trang không hợp lệ.');
  }

  if (!query.token) {
    throw new AppError('MEDIA_TOKEN_INVALID', 'Liên kết xem tệp không hợp lệ.');
  }

  const claims = await verifyMediaToken(query.token);
  if (claims.documentId !== documentId || claims.fileId !== fileId) {
    throw new AppError('MEDIA_TOKEN_INVALID', 'Liên kết xem tệp không hợp lệ.');
  }

  const target = await service.resolvePageImageTarget(documentId, fileId, pageNum);

  return streamObject(request, reply, {
    location: { bucket: target.bucket, key: target.key },
    contentType: 'image/jpeg',
    disposition: {
      kind: 'inline',
      filename: `page-${pageNum}.jpg`,
    },
    cacheControl: 'public, max-age=86400, immutable',
  });
}

export async function rateDocument(request: FastifyRequest, reply: FastifyReply) {
  const actor = await requireActor(request);
  const { id } = parseParams(documentIdParamSchema, request.params);
  const body = parseBody(ratingSchema, request.body);
  const result = await service.rateDocument(id, body, actor);
  return reply.ok(result, {}, 'Cảm ơn bạn đã đánh giá.');
}

export async function removeRating(request: FastifyRequest, reply: FastifyReply) {
  const actor = await requireActor(request);
  const { id } = parseParams(documentIdParamSchema, request.params);
  await service.removeRating(id, actor);
  return reply.ok({ removed: true }, {}, 'Đã xoá đánh giá.');
}

export async function listRatings(request: FastifyRequest, reply: FastifyReply) {
  const { id } = parseParams(documentIdParamSchema, request.params);
  const query = parseQuery(listDocumentsQuerySchema.pick({ page: true, limit: true }), request.query);
  return sendPaginated(reply, await service.listRatings(id, query));
}

// --- Moderation --------------------------------------------------------------

export async function moderateDocument(request: FastifyRequest, reply: FastifyReply) {
  const actor = await requireActor(request);
  const { id } = parseParams(documentIdParamSchema, request.params);
  const body = parseBody(moderateDocumentSchema, request.body);
  return reply.ok(
    await service.moderateDocument(id, body, actor),
    {},
    'Đã cập nhật trạng thái kiểm duyệt.',
  );
}

export async function listModerationQueue(request: FastifyRequest, reply: FastifyReply) {
  const actor = await requireActor(request);
  const query = parseQuery(
    listDocumentsQuerySchema.pick({ page: true, limit: true }).extend({
      status: listDocumentsQuerySchema.shape.status,
      facultyId: listDocumentsQuerySchema.shape.facultyId,
    }),
    request.query,
  );

  const result = await service.listModerationQueue(
    actor,
    { status: query.status, facultyId: query.facultyId },
    query,
  );
  return sendPaginated(reply, result);
}

export async function listTags(_request: FastifyRequest, reply: FastifyReply) {
  return reply.ok(await service.listPopularTags());
}
