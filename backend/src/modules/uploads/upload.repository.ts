import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';

import { db, type Database } from '../../db/client.js';
import {
  documentFiles,
  storageObjects,
  uploadChunks,
  uploadSessions,
} from '../../db/schema/index.js';

export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
export type Executor = Tx | typeof db;

/**
 * Chunked upload data access.
 *
 * The chunk table's primary key is `(session_id, chunk_index)`, and every
 * write here relies on that: re-sending a chunk after a dropped connection
 * updates the existing row instead of appending a duplicate part, which would
 * corrupt the assembled file in a way that only shows up when someone opens it
 * weeks later.
 */

export interface UploadSessionRecord {
  id: string;
  userId: string;
  originalName: string;
  declaredMime: string | null;
  totalSize: number;
  chunkSize: number;
  totalChunks: number;
  status: 'pending' | 'assembling' | 'completed' | 'aborted' | 'expired';
  receivedChunks: number;
  s3UploadId: string;
  stagingKey: string;
  contentHash: Buffer | null;
  detectedMime: string | null;
  expiresAt: Date;
  documentId: string | null;
}

/**
 * Two mappers, because this module reads the same table through two paths and
 * they produce DIFFERENT key shapes.
 *
 * Drizzle's query builder maps columns to the schema's TypeScript property
 * names, so a row from `.select()` has `userId`, `s3UploadId`, `expiresAt`.
 * Raw SQL via `tx.execute()` returns the database's own column names:
 * `user_id`, `s3_upload_id`. Sharing one mapper between them silently produces
 * `undefined` for every field, which then fails an ownership comparison and
 * surfaces as a misleading "session not found".
 */
function fromDrizzleRow(row: typeof uploadSessions.$inferSelect): UploadSessionRecord {
  return {
    id: row.id,
    userId: row.userId,
    originalName: row.originalName,
    declaredMime: row.declaredMime,
    totalSize: Number(row.totalSize),
    chunkSize: row.chunkSize,
    totalChunks: row.totalChunks,
    status: row.status,
    receivedChunks: row.receivedChunks,
    s3UploadId: row.s3UploadId,
    stagingKey: row.stagingKey,
    contentHash: row.contentHash,
    detectedMime: row.detectedMime,
    expiresAt: row.expiresAt,
    documentId: row.documentId,
  };
}

function fromRawRow(row: Record<string, unknown>): UploadSessionRecord {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    originalName: row.original_name as string,
    declaredMime: (row.declared_mime as string | null) ?? null,
    totalSize: Number(row.total_size),
    chunkSize: Number(row.chunk_size),
    totalChunks: Number(row.total_chunks),
    status: row.status as UploadSessionRecord['status'],
    receivedChunks: Number(row.received_chunks),
    s3UploadId: row.s3_upload_id as string,
    stagingKey: row.staging_key as string,
    contentHash: (row.content_hash as Buffer | null) ?? null,
    detectedMime: (row.detected_mime as string | null) ?? null,
    // Raw SQL bypasses pg's type parsers, so timestamps arrive as strings.
    expiresAt: row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at as string),
    documentId: (row.document_id as string | null) ?? null,
  };
}

export async function createSession(
  executor: Executor,
  values: {
    userId: string;
    originalName: string;
    declaredMime: string | null;
    totalSize: number;
    chunkSize: number;
    totalChunks: number;
    s3UploadId: string;
    stagingKey: string;
    expiresAt: Date;
  },
): Promise<UploadSessionRecord> {
  const [row] = await executor.insert(uploadSessions).values(values).returning();
  return fromDrizzleRow(row!);
}

export async function findSessionById(
  executor: Executor,
  id: string,
): Promise<UploadSessionRecord | null> {
  const rows = await executor
    .select()
    .from(uploadSessions)
    .where(eq(uploadSessions.id, id))
    .limit(1);

  const row = rows[0];
  return row ? fromDrizzleRow(row) : null;
}

/**
 * Lock a session row for the duration of a state transition.
 *
 * Completion is not idempotent in a useful way — assembling twice would issue
 * two S3 CompleteMultipartUpload calls, the second of which fails with
 * NoSuchUpload and leaves the caller unsure whether their file survived.
 * Serialising on the row makes the second caller observe `completed` instead.
 */
export async function lockSession(tx: Tx, id: string): Promise<UploadSessionRecord | null> {
  const result = await tx.execute<Record<string, unknown>>(
    sql`SELECT * FROM upload_sessions WHERE id = ${id} FOR UPDATE`,
  );
  const row = result.rows[0];
  return row ? fromRawRow(row) : null;
}

/** Record a received chunk. Idempotent on (session, index). */
export async function recordChunk(
  executor: Executor,
  values: { sessionId: string; chunkIndex: number; sizeBytes: number; etag: string },
): Promise<void> {
  await executor
    .insert(uploadChunks)
    .values(values)
    .onConflictDoUpdate({
      target: [uploadChunks.sessionId, uploadChunks.chunkIndex],
      set: { etag: values.etag, sizeBytes: values.sizeBytes, receivedAt: new Date() },
    });
}

export async function listReceivedChunks(
  executor: Executor,
  sessionId: string,
): Promise<{ chunkIndex: number; etag: string; sizeBytes: number }[]> {
  const rows = await executor
    .select({
      chunkIndex: uploadChunks.chunkIndex,
      etag: uploadChunks.etag,
      sizeBytes: uploadChunks.sizeBytes,
    })
    .from(uploadChunks)
    .where(eq(uploadChunks.sessionId, sessionId))
    .orderBy(uploadChunks.chunkIndex);
  return rows;
}

export async function countReceivedChunks(executor: Executor, sessionId: string): Promise<number> {
  const [row] = await executor
    .select({ value: sql<number>`count(*)::int` })
    .from(uploadChunks)
    .where(eq(uploadChunks.sessionId, sessionId));
  return Number(row?.value ?? 0);
}

export async function updateSession(
  executor: Executor,
  id: string,
  values: Partial<{
    status: UploadSessionRecord['status'];
    receivedChunks: number;
    contentHash: Buffer;
    detectedMime: string;
    documentId: string;
    failureReason: string;
    completedAt: Date;
  }>,
): Promise<void> {
  await executor
    .update(uploadSessions)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(uploadSessions.id, id));
}

export async function deleteChunks(executor: Executor, sessionId: string): Promise<void> {
  await executor.delete(uploadChunks).where(eq(uploadChunks.sessionId, sessionId));
}

export async function listSessionsForUser(executor: Executor, userId: string) {
  const rows = await executor
    .select({
      id: uploadSessions.id,
      originalName: uploadSessions.originalName,
      totalSize: uploadSessions.totalSize,
      totalChunks: uploadSessions.totalChunks,
      receivedChunks: uploadSessions.receivedChunks,
      status: uploadSessions.status,
      createdAt: uploadSessions.createdAt,
      expiresAt: uploadSessions.expiresAt,
    })
    .from(uploadSessions)
    .where(and(eq(uploadSessions.userId, userId), eq(uploadSessions.status, 'pending')))
    .orderBy(desc(uploadSessions.createdAt))
    .limit(50);
  return rows;
}

// --- Storage objects ---------------------------------------------------------

export async function findStorageObjectByHash(executor: Executor, contentHash: Buffer) {
  const rows = await executor
    .select()
    .from(storageObjects)
    .where(eq(storageObjects.contentHash, contentHash))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Insert a storage object, tolerating a concurrent insert of the same hash.
 *
 * Two users uploading the same file at the same moment would otherwise both
 * miss the existence check and both insert, and the second would fail on the
 * primary key. `ON CONFLICT DO NOTHING` plus a re-read makes the race benign.
 */
export async function insertStorageObject(
  executor: Executor,
  values: {
    contentHash: Buffer;
    bucket: string;
    objectKey: string;
    sizeBytes: number;
    detectedMime: string;
  },
): Promise<{ contentHash: Buffer; objectKey: string }> {
  await executor
    .insert(storageObjects)
    .values({ ...values, refCount: 0 })
    .onConflictDoNothing({ target: storageObjects.contentHash });

  const stored = await findStorageObjectByHash(executor, values.contentHash);
  if (!stored) {
    throw new Error('Storage object vanished immediately after insert.');
  }
  return { contentHash: stored.contentHash, objectKey: stored.objectKey };
}

export async function updateStorageObject(
  executor: Executor,
  contentHash: Buffer,
  values: {
    bucket: string;
    objectKey: string;
    sizeBytes: number;
    detectedMime: string;
  },
): Promise<void> {
  await executor
    .update(storageObjects)
    .set(values)
    .where(eq(storageObjects.contentHash, contentHash));
}

/**
 * Increment the reference count, creating the row if necessary.
 *
 * Must run in the same transaction as the `document_files` insert. If the two
 * could diverge, a document could reference an object whose count says zero,
 * and the reaper would delete bytes that are still in use — silent data loss
 * that surfaces as a broken download months later.
 */
export async function incrementRefCount(executor: Executor, contentHash: Buffer): Promise<void> {
  await executor
    .update(storageObjects)
    .set({ refCount: sql`${storageObjects.refCount} + 1` })
    .where(eq(storageObjects.contentHash, contentHash));
}

export async function decrementRefCount(executor: Executor, contentHash: Buffer): Promise<number> {
  const [row] = await executor
    .update(storageObjects)
    .set({ refCount: sql`GREATEST(${storageObjects.refCount} - 1, 0)` })
    .where(eq(storageObjects.contentHash, contentHash))
    .returning({ refCount: storageObjects.refCount });
  return Number(row?.refCount ?? 0);
}

export async function insertDocumentFile(
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
  },
): Promise<{ id: string }> {
  const [row] = await executor.insert(documentFiles).values(values).returning({ id: documentFiles.id });
  return { id: row!.id };
}

// --- Reaping -----------------------------------------------------------------

/**
 * Find sessions abandoned mid-upload.
 *
 * A chunked upload that stops halfway leaks an S3 multipart upload. Those parts
 * are invisible to normal object listings and are not billed as objects, so
 * without an explicit abort they accumulate indefinitely and quietly consume
 * storage.
 */
export async function findExpiredSessions(executor: Executor, limit = 50) {
  const rows = await executor
    .select({
      id: uploadSessions.id,
      s3UploadId: uploadSessions.s3UploadId,
      stagingKey: uploadSessions.stagingKey,
    })
    .from(uploadSessions)
    .where(
      and(
        inArray(uploadSessions.status, ['pending', 'assembling']),
        lt(uploadSessions.expiresAt, new Date()),
      ),
    )
    .limit(limit);
  return rows;
}
