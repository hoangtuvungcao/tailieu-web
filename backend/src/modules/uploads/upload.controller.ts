import type { Readable } from 'node:stream';

import type { FastifyReply, FastifyRequest } from 'fastify';

import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { ALLOWED_EXTENSIONS } from '../../lib/files/mime.js';
import { parseBody, parseParams } from '../../lib/validation.js';
import * as service from './upload.service.js';
import { chunkParamsSchema, createUploadSchema, sessionParamsSchema } from './upload.schema.js';

/**
 * Upload HTTP layer.
 *
 * The chunk endpoint accepts a raw `application/octet-stream` body — not
 * multipart. Multipart would wrap each ~8MB chunk in a boundary envelope and
 * force a parser to walk it looking for delimiters, which is pure overhead for
 * a body that is already exactly one binary blob. It also avoids the very
 * common temptation to call `part.toBuffer()`, which buffers the whole chunk.
 */

function chunkBody(request: FastifyRequest): Readable {
  const body = request.body;
  if (body === null || typeof body !== 'object' || typeof (body as Readable).pipe !== 'function') {
    // Reached when the request carried a JSON or form body instead of raw
    // bytes, or when the content-type parser is missing.
    throw new AppError(
      'BAD_REQUEST',
      'Nội dung phần tải lên phải là dữ liệu nhị phân (application/octet-stream).',
    );
  }
  return body as Readable;
}

export async function createUpload(request: FastifyRequest, reply: FastifyReply) {
  const body = parseBody(createUploadSchema, request.body);
  const result = await service.createUpload(body, request.user!.id);

  reply.status(201);
  return reply.ok(result, {}, 'Bắt đầu tải lên.');
}

/**
 * Receive one chunk.
 *
 * The response always reports the full list of received indices so a client
 * that lost its own bookkeeping can resynchronise from the server rather than
 * guessing which chunks to re-send.
 */
export async function uploadChunk(request: FastifyRequest, reply: FastifyReply) {
  const params = parseParams(chunkParamsSchema, request.params);
  const contentLengthHeader = request.headers['content-length'];
  const contentLength = contentLengthHeader ? Number(contentLengthHeader) : null;

  const result = await service.receiveChunk(
    {
      uploadId: params.id,
      chunkIndex: params.index,
      body: chunkBody(request),
      contentLength: Number.isFinite(contentLength) ? contentLength : null,
    },
    request.user!.id,
  );

  return reply.ok({
    receivedChunks: result.receivedChunks,
    receivedChunksList: result.receivedChunksList,
  });
}

export async function getUploadStatus(request: FastifyRequest, reply: FastifyReply) {
  const { id } = parseParams(sessionParamsSchema, request.params);
  return reply.ok(await service.getUploadStatus(id, request.user!.id));
}

export async function completeUpload(request: FastifyRequest, reply: FastifyReply) {
  const { id } = parseParams(sessionParamsSchema, request.params);
  const result = await service.completeUpload(id, request.user!.id);
  return reply.ok(result, {}, 'Tải lên hoàn tất.');
}

export async function abortUpload(request: FastifyRequest, reply: FastifyReply) {
  const { id } = parseParams(sessionParamsSchema, request.params);
  await service.abortUpload(id, request.user!.id);
  return reply.ok({ aborted: true }, {}, 'Đã huỷ tải lên.');
}

export async function listUploads(request: FastifyRequest, reply: FastifyReply) {
  return reply.ok(await service.listActiveUploads(request.user!.id));
}

/**
 * The accepted formats, so the upload UI does not have to hard-code them.
 *
 * Serving this means adding a format to the backend allowlist immediately
 * reflects in the file picker's `accept` attribute and the error copy, with no
 * frontend release.
 */
export async function allowedTypes(_request: FastifyRequest, reply: FastifyReply) {
  return reply.ok({
    extensions: ALLOWED_EXTENSIONS,
    maxSizeBytes: env.MAX_UPLOAD_SIZE_BYTES,
    chunkSizeBytes: env.UPLOAD_CHUNK_SIZE_BYTES,
  });
}
