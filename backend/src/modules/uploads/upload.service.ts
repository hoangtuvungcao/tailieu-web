import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';

import { durations, env } from '../../config/env.js';
import { db } from '../../db/client.js';
import { AppError } from '../../lib/errors.js';
import {
  buildStorageKey,
  createHeadCapture,
  detectFileType,
  FileSignatureMismatchError,
  UnsupportedFileTypeError,
  type FileKind,
} from '../../lib/files/mime.js';
import { sanitizeFilename } from '../../lib/http/content-disposition.js';
import { getStorage } from '../../lib/storage/index.js';
import type { RequestContext } from '../auth/auth.service.js';
import * as repo from './upload.repository.js';

/**
 * Chunked, resumable upload service.
 *
 * Why chunking exists at all: every byte a browser sends travels through the
 * Cloudflare Pages Function, and Cloudflare rejects proxied request bodies
 * above 100MB. A 300MB scanned thesis therefore cannot be uploaded in one
 * request regardless of what this service does. ~8MB chunks keep each request
 * well inside the limit, and make the upload resumable as a side effect —
 * which on a laptop behind a home connection is the common case.
 *
 * Chunks are written straight to S3 multipart parts. The server never holds
 * more than one chunk in memory and never writes to local disk, so memory use
 * is flat regardless of file size and the API stays portable to another host.
 */

export interface UploadIntentResult {
  uploadId: string;
  chunkSize: number;
  totalChunks: number;
  receivedChunks: number[];
  expiresAt: string;
}

export interface CompletedUpload {
  uploadId: string;
  contentHash: string;
  sizeBytes: number;
  detectedMime: string;
  fileKind: FileKind;
  extension: string;
  originalName: string;
  /** True when an identical file already existed and storage was saved. */
  deduplicated: boolean;
}

/** Reject before creating any state if the declared size is impossible. */
function validateSize(sizeBytes: number): number {
  if (sizeBytes <= 0) {
    throw new AppError('BAD_REQUEST', 'Kích thước tệp không hợp lệ.');
  }
  if (sizeBytes > env.MAX_UPLOAD_SIZE_BYTES) {
    const limitMb = Math.floor(env.MAX_UPLOAD_SIZE_BYTES / (1024 * 1024));
    throw new AppError(
      'PAYLOAD_TOO_LARGE',
      `Tệp vượt quá giới hạn cho phép (${limitMb} MB).`,
    );
  }
  return sizeBytes;
}

/**
 * Begin an upload.
 *
 * Creates the session row and the S3 multipart upload together, then returns
 * the chunk layout. The client is told exactly which chunks to send and which
 * are already present, so an interrupted upload resumes by re-sending only
 * what is missing rather than starting over.
 */
export async function createUpload(
  input: { fileName: string; sizeBytes: number; mimeType: string | null },
  userId: string,
): Promise<UploadIntentResult> {
  const sizeBytes = validateSize(input.sizeBytes);

  // The filename is echoed back to the user and used in the download header,
  // so it is stripped of any path component and control characters first. It
  // never contributes to the storage key.
  const originalName = sanitizeFilename(input.fileName);

  const chunkSize = env.UPLOAD_CHUNK_SIZE_BYTES;
  const totalChunks = Math.ceil(sizeBytes / chunkSize);

  if (totalChunks > 100_000) {
    throw new AppError('BAD_REQUEST', 'Tệp có quá nhiều phần để xử lý.');
  }

  // A provisional key. The extension is replaced at completion, once the real
  // type is known from the bytes rather than from the filename.
  const storageKey = buildStorageKey();
  const storage = getStorage();

  const init = await storage.createMultipartUpload({
    bucket: env.S3_BUCKET,
    key: storageKey,
    // Placeholder. Sealed with the detected type at completion.
    contentType: 'application/octet-stream',
    metadata: { uploader: userId },
  });

  const expiresAt = new Date(Date.now() + durations.uploadSessionMs);

  try {
    const session = await repo.createSession(db, {
      userId,
      originalName,
      declaredMime: input.mimeType,
      totalSize: sizeBytes,
      chunkSize,
      totalChunks,
      s3UploadId: init.uploadId,
      stagingKey: storageKey,
      expiresAt,
    });

    return {
      uploadId: session.id,
      chunkSize,
      totalChunks,
      receivedChunks: [],
      expiresAt: expiresAt.toISOString(),
    };
  } catch (error) {
    // Never leave a multipart upload behind on a failed session insert: its
    // parts are invisible to listings and would consume storage forever.
    await storage
      .abortMultipartUpload({
        bucket: env.S3_BUCKET,
        key: storageKey,
        uploadId: init.uploadId,
      })
      .catch(() => undefined);
    throw error;
  }
}

/**
 * Receive one chunk.
 *
 * The upload session is verified to belong to the caller before any bytes are
 * read. Skipping that check is a classic IDOR: session ids are UUIDs, but a
 * leaked or logged id must not let an attacker append bytes to someone else's
 * upload.
 */
export async function receiveChunk(
  input: {
    uploadId: string;
    chunkIndex: number;
    body: Readable;
    contentLength: number | null;
  },
  userId: string,
): Promise<{ receivedChunks: number; receivedChunksList: number[] }> {
  const session = await repo.findSessionById(db, input.uploadId);

  if (!session) {
    throw new AppError('UPLOAD_SESSION_NOT_FOUND', 'Không tìm thấy phiên tải lên.');
  }
  if (session.userId !== userId) {
    // Same error as "not found" on purpose: distinguishing them would confirm
    // that a session id exists to someone who does not own it.
    throw new AppError('UPLOAD_SESSION_NOT_FOUND', 'Không tìm thấy phiên tải lên.');
  }
  if (session.status === 'completed') {
    throw new AppError('UPLOAD_SESSION_COMPLETED', 'Phiên tải lên này đã hoàn tất.');
  }
  if (session.status === 'aborted' || session.status === 'expired') {
    throw new AppError('UPLOAD_SESSION_EXPIRED', 'Phiên tải lên đã hết hạn. Vui lòng thử lại.');
  }
  if (session.expiresAt.getTime() < Date.now()) {
    throw new AppError('UPLOAD_SESSION_EXPIRED', 'Phiên tải lên đã hết hạn. Vui lòng thử lại.');
  }
  if (input.chunkIndex >= session.totalChunks) {
    throw new AppError(
      'UPLOAD_CHUNK_OUT_OF_RANGE',
      `Phần ${input.chunkIndex} nằm ngoài phạm vi (tệp có ${session.totalChunks} phần).`,
    );
  }

  // Every chunk except the last must be exactly chunkSize. Allowing a short
  // middle chunk would shift every subsequent byte and produce a corrupt file
  // that only fails when someone opens it.
  const isLastChunk = input.chunkIndex === session.totalChunks - 1;
  const expectedBytes = isLastChunk
    ? session.totalSize - session.chunkSize * (session.totalChunks - 1)
    : session.chunkSize;

  if (input.contentLength !== null && input.contentLength !== expectedBytes) {
    throw new AppError(
      'BAD_REQUEST',
      `Phần ${input.chunkIndex} phải có ${expectedBytes} byte, nhưng nhận được ${input.contentLength}.`,
    );
  }

  // Sniff the first chunk. This is the only point at which the file's real
  // type can be established, and doing it here means a disallowed file is
  // rejected after ~8MB rather than after the whole upload.
  let detectedMime: string | undefined;
  let body: Readable = input.body;

  if (input.chunkIndex === 0) {
    const capture = createHeadCapture();
    input.body.pipe(capture.stream);
    body = capture.stream;

    // Resolves as soon as enough bytes have passed through, or immediately for
    // a file smaller than the sniff window. Awaiting this does NOT consume the
    // stream — the capture resolves from inside its own transform — so the
    // bytes are still there for the part upload below.
    const head = await capture.head;

    try {
      const detection = await detectFileType(head, session.originalName, session.declaredMime);
      if (!detection) {
        throw new AppError('FILE_TYPE_NOT_ALLOWED', 'Không nhận dạng được loại tệp.');
      }
      detectedMime = detection.mime;
      await repo.updateSession(db, session.id, { detectedMime: detection.mime });
    } catch (error) {
      // Abort the whole multipart upload, not just this part: the file is
      // unacceptable, so keeping the session alive would only invite a retry
      // that fails identically.
      await abortSession(session, 'rejected file type');
      throw toAppError(error);
    }
  }

  // Stream the chunk to S3 as a multipart part. `expectedBytes` is enforced
  // inside the driver by counting bytes as they pass, which catches a client
  // that under-sends or over-sends relative to Content-Length.
  const part = await getStorage().uploadPart({
    bucket: env.S3_BUCKET,
    key: session.stagingKey,
    uploadId: session.s3UploadId,
    // S3 part numbers are 1-based; the client's chunk index is 0-based.
    partNumber: input.chunkIndex + 1,
    body,
    expectedBytes,
  });

  await repo.recordChunk(db, {
    sessionId: session.id,
    chunkIndex: input.chunkIndex,
    sizeBytes: expectedBytes,
    etag: part.etag,
  });

  const chunks = await repo.listReceivedChunks(db, session.id);
  await repo.updateSession(db, session.id, { receivedChunks: chunks.length });

  void detectedMime;
  return {
    receivedChunks: chunks.length,
    receivedChunksList: chunks.map((c) => c.chunkIndex),
  };
}

function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;

  if (error instanceof UnsupportedFileTypeError) {
    return new AppError(
      'FILE_TYPE_NOT_ALLOWED',
      `Định dạng tệp không được hỗ trợ${error.detected ? ` (${error.detected})` : ''}. ` +
        'Chỉ chấp nhận tài liệu, bảng tính, slide, ảnh, nén, văn bản và mã nguồn.',
    );
  }

  if (error instanceof FileSignatureMismatchError) {
    // The message names both types because this is usually a renamed file the
    // user can fix, not an attack.
    return new AppError(
      'FILE_SIGNATURE_MISMATCH',
      `Nội dung tệp không khớp với định dạng khai báo (khai báo ${error.declared ?? 'không rõ'}, ` +
        `thực tế ${error.detected}). Tệp có thể đã bị đổi tên sai phần mở rộng.`,
    );
  }

  return new AppError('INTERNAL_ERROR', 'Tải lên thất bại.', { cause: error });
}

async function abortSession(session: repo.UploadSessionRecord, reason: string): Promise<void> {
  await getStorage()
    .abortMultipartUpload({
      bucket: env.S3_BUCKET,
      key: session.stagingKey,
      uploadId: session.s3UploadId,
    })
    .catch(() => undefined);

  await repo
    .updateSession(db, session.id, { status: 'aborted', failureReason: reason })
    .catch(() => undefined);
}

/**
 * Assemble the upload into a usable file.
 *
 * Steps, and why each exists:
 *
 *   1. All chunks present? Assembling a partial upload produces a truncated
 *      file that downloads fine and opens as corrupt.
 *   2. Complete the S3 multipart upload.
 *   3. Stream the assembled object back through SHA-256. The hash cannot be
 *      computed incrementally from the chunks, because chunks may arrive out
 *      of order and SHA-256 is not combinable from per-chunk digests. This is
 *      a full read of the file — O(1) memory, but real I/O, and the price of
 *      content-addressed dedup. It is the main candidate for optimisation if
 *      upload completion ever becomes a bottleneck.
 *   4. Deduplicate: if an identical object already exists, discard this copy
 *      and point at the existing one.
 */
export async function completeUpload(
  uploadId: string,
  userId: string,
): Promise<CompletedUpload> {
  const outcome = await db.transaction(async (tx) => {
    const session = await repo.lockSession(tx, uploadId);

    if (!session) {
      throw new AppError('UPLOAD_SESSION_NOT_FOUND', 'Không tìm thấy phiên tải lên.');
    }
    if (session.userId !== userId) {
      throw new AppError('UPLOAD_SESSION_NOT_FOUND', 'Không tìm thấy phiên tải lên.');
    }
    if (session.status === 'completed') {
      // Idempotent: the client may retry after a network failure that lost the
      // original response.
      if (session.contentHash) {
        const existing = await repo.findStorageObjectByHash(tx, session.contentHash);
        if (existing) {
          return {
            contentHash: session.contentHash,
            objectKey: existing.objectKey,
            detectedMime: existing.detectedMime,
            sizeBytes: Number(existing.sizeBytes),
            deduplicated: false,
          };
        }
      }
      throw new AppError('UPLOAD_SESSION_COMPLETED', 'Phiên tải lên này đã hoàn tất.');
    }
    if (session.status === 'aborted' || session.status === 'expired') {
      throw new AppError('UPLOAD_SESSION_EXPIRED', 'Phiên tải lên đã hết hạn.');
    }

    const chunks = await repo.listReceivedChunks(tx, session.id);
    if (chunks.length !== session.totalChunks) {
      const missing: number[] = [];
      const present = new Set(chunks.map((c) => c.chunkIndex));
      for (let i = 0; i < session.totalChunks; i += 1) {
        if (!present.has(i)) missing.push(i);
      }
      throw new AppError(
        'UPLOAD_INCOMPLETE',
        `Còn thiếu ${missing.length} phần chưa tải lên.`,
        { details: { missingChunks: missing.slice(0, 100), totalChunks: session.totalChunks } },
      );
    }

    await repo.updateSession(tx, session.id, { status: 'assembling' });

    const storage = getStorage();

    await storage.completeMultipartUpload({
      bucket: env.S3_BUCKET,
      key: session.stagingKey,
      uploadId: session.s3UploadId,
      parts: chunks.map((c) => ({ partNumber: c.chunkIndex + 1, etag: c.etag })),
    });

    // Hash the assembled object and confirm the size matches what was declared.
    const { contentHash, sizeBytes } = await hashStoredObject(session.stagingKey);

    if (sizeBytes !== session.totalSize) {
      await storage
        .deleteObject({ bucket: env.S3_BUCKET, key: session.stagingKey })
        .catch(() => undefined);
      throw new AppError(
        'BAD_REQUEST',
        `Kích thước tệp sau khi ghép (${sizeBytes}) không khớp với khai báo (${session.totalSize}).`,
      );
    }

    const detection =
      session.detectedMime !== null
        ? { mime: session.detectedMime }
        : { mime: 'application/octet-stream' };

    const existing = await repo.findStorageObjectByHash(tx, contentHash);

    if (existing) {
      // Verify that the existing storage object ACTUALLY exists on the storage backend.
      // If it was lost or deleted, we must NOT discard the newly assembled file.
      const existsInStorage = await storage
        .objectExists({ bucket: existing.bucket, key: existing.objectKey })
        .catch(() => false);

      if (existsInStorage) {
        // Dedup hit & verified alive. Discard the redundant copy we just assembled.
        await storage
          .deleteObject({ bucket: env.S3_BUCKET, key: session.stagingKey })
          .catch(() => undefined);

        await repo.updateSession(tx, session.id, {
          status: 'completed',
          contentHash,
          detectedMime: detection.mime,
          completedAt: new Date(),
        });

        return {
          contentHash,
          objectKey: existing.objectKey,
          detectedMime: existing.detectedMime,
          sizeBytes: Number(existing.sizeBytes),
          deduplicated: true,
        };
      }

      // Self-heal: the existing record points to missing bytes, so keep the newly
      // assembled object at stagingKey and update the storage record to point to it.
      await repo.updateStorageObject(tx, contentHash, {
        bucket: env.S3_BUCKET,
        objectKey: session.stagingKey,
        sizeBytes,
        detectedMime: detection.mime,
      });

      await repo.updateSession(tx, session.id, {
        status: 'completed',
        contentHash,
        detectedMime: detection.mime,
        completedAt: new Date(),
      });

      return {
        contentHash,
        objectKey: session.stagingKey,
        detectedMime: detection.mime,
        sizeBytes,
        deduplicated: false,
      };
    }

    const stored = await repo.insertStorageObject(tx, {
      contentHash,
      bucket: env.S3_BUCKET,
      objectKey: session.stagingKey,
      sizeBytes,
      detectedMime: detection.mime,
    });

    await repo.updateSession(tx, session.id, {
      status: 'completed',
      contentHash,
      detectedMime: detection.mime,
      completedAt: new Date(),
    });

    return {
      contentHash,
      objectKey: stored.objectKey,
      detectedMime: detection.mime,
      sizeBytes,
      deduplicated: false,
    };
  });

  // Re-derive the friendly metadata from the original name for the response.
  const session = await repo.findSessionById(db, uploadId);
  const extension = (session?.originalName.split('.').pop() ?? '').toLowerCase();

  return {
    uploadId,
    contentHash: outcome.contentHash.toString('hex'),
    sizeBytes: outcome.sizeBytes,
    detectedMime: outcome.detectedMime,
    fileKind: kindFromMime(outcome.detectedMime),
    extension,
    originalName: session?.originalName ?? 'unknown',
    deduplicated: outcome.deduplicated,
  };
}

/**
 * Stream the stored object through SHA-256 and count its bytes.
 *
 * Never buffers: a 2GB file is hashed with constant memory.
 */
async function hashStoredObject(key: string): Promise<{ contentHash: Buffer; sizeBytes: number }> {
  const stream = await getStorage().getStream({ bucket: env.S3_BUCKET, key });
  const hash = createHash('sha256');
  let sizeBytes = 0;

  for await (const chunk of stream) {
    const buffer = chunk as Buffer;
    sizeBytes += buffer.length;
    hash.update(buffer);
  }

  return { contentHash: hash.digest(), sizeBytes };
}

/** Current state of an upload, for resuming after a dropped connection. */
export async function getUploadStatus(uploadId: string, userId: string) {
  const session = await repo.findSessionById(db, uploadId);

  if (!session || session.userId !== userId) {
    throw new AppError('UPLOAD_SESSION_NOT_FOUND', 'Không tìm thấy phiên tải lên.');
  }

  const chunks = await repo.listReceivedChunks(db, session.id);

  return {
    uploadId: session.id,
    fileName: session.originalName,
    sizeBytes: session.totalSize,
    chunkSize: session.chunkSize,
    totalChunks: session.totalChunks,
    receivedChunks: chunks.map((c) => c.chunkIndex),
    status: session.status,
    expiresAt: session.expiresAt.toISOString(),
    completed: session.status === 'completed',
  };
}

export async function abortUpload(uploadId: string, userId: string): Promise<void> {
  const session = await repo.findSessionById(db, uploadId);

  if (!session || session.userId !== userId) {
    throw new AppError('UPLOAD_SESSION_NOT_FOUND', 'Không tìm thấy phiên tải lên.');
  }
  if (session.status === 'completed') {
    throw new AppError('UPLOAD_SESSION_COMPLETED', 'Không thể huỷ phiên đã hoàn tất.');
  }

  await abortSession(session, 'cancelled by user');
}

export function listActiveUploads(userId: string) {
  return repo.listSessionsForUser(db, userId);
}

function kindFromMime(mime: string): FileKind {
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('text/')) return 'text';
  if (mime === 'application/zip' || mime.includes('rar') || mime.includes('7z') || mime.includes('tar') || mime.includes('gzip')) {
    return 'archive';
  }
  if (mime.includes('word') || mime.includes('opendocument.text') || mime === 'application/rtf') {
    return 'document';
  }
  if (mime.includes('sheet') || mime.includes('excel') || mime.includes('csv')) return 'spreadsheet';
  if (mime.includes('presentation') || mime.includes('powerpoint')) return 'presentation';
  return 'other';
}

export type { RequestContext };
