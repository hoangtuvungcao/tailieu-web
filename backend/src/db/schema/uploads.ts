import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { bytea } from './custom-types.js';
import { uploadSessionStatusEnum } from './enums.js';
import { users } from './identity.js';
import { documents } from './documents.js';

/**
 * Resumable chunked uploads.
 *
 * Why this exists rather than a single POST: every byte a browser sends
 * travels through the Cloudflare Pages Function, and Cloudflare rejects any
 * proxied request body above 100MB. A 300MB scanned thesis therefore cannot be
 * uploaded in one request no matter what the API does. Splitting the file into
 * ~8MB chunks keeps each request comfortably inside the limit and, as a side
 * effect, makes the upload resumable after a dropped connection — which on a
 * laptop behind a home ISP is the common case, not the edge case.
 *
 * Each chunk is written directly to S3 as a multipart part, so the server
 * never holds more than one chunk in memory and never writes to local disk.
 * That is what keeps the backend portable to another host later.
 */

export const uploadSessions = pgTable(
  'upload_sessions',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Set once the upload completes and a document is created from it. */
    documentId: uuid('document_id').references(() => documents.id, { onDelete: 'set null' }),

    originalName: text('original_name').notNull(),
    declaredMime: text('declared_mime'),
    totalSize: bigint('total_size', { mode: 'number' }).notNull(),
    chunkSize: integer('chunk_size').notNull(),
    totalChunks: integer('total_chunks').notNull(),

    status: uploadSessionStatusEnum('status').notNull().default('pending'),
    /** Count of chunks whose part landed in S3. Drives the resume response. */
    receivedChunks: integer('received_chunks').notNull().default(0),

    /** S3 multipart upload id, used to assemble the parts. */
    s3UploadId: text('s3_upload_id').notNull(),
    /** Staging key. The final content-addressed key is chosen at completion. */
    stagingKey: text('staging_key').notNull(),

    /** sha256 computed incrementally as chunks arrive. */
    contentHash: bytea('content_hash'),
    /** Sniffed from the first chunk's leading bytes. */
    detectedMime: text('detected_mime'),

    failureReason: text('failure_reason'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('upload_sessions_user_idx').on(t.userId, t.createdAt.desc()),
    // Reaping job: abandoned sessions leak S3 multipart parts until aborted.
    index('upload_sessions_reap_idx')
      .on(t.expiresAt)
      .where(sql`status IN ('pending', 'assembling')`),
    index('upload_sessions_staging_key_idx').on(t.stagingKey),
  ],
);

/**
 * One row per received chunk. The unique key is what makes a retried chunk
 * idempotent: re-sending the same index updates the existing row instead of
 * creating a duplicate part and corrupting the assembled file.
 */
export const uploadChunks = pgTable(
  'upload_chunks',
  {
    sessionId: uuid('session_id')
      .notNull()
      .references(() => uploadSessions.id, { onDelete: 'cascade' }),
    /** Zero-based chunk index. The S3 part number is this + 1. */
    chunkIndex: integer('chunk_index').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    /** ETag returned by S3, required to complete the multipart upload. */
    etag: text('etag').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.chunkIndex] }),
    index('upload_chunks_session_idx').on(t.sessionId),
  ],
);

/**
 * Reserved: per-user upload quota accounting for the storage dashboard (§60).
 * Present in M1 so usage can be accumulated from day one rather than
 * back-filled from download logs later.
 */
export const storageUsage = pgTable(
  'storage_usage',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Sum of `size_bytes` over this user's live document files. */
    usedBytes: bigint('used_bytes', { mode: 'number' }).notNull().default(0),
    quotaBytes: bigint('quota_bytes', { mode: 'number' }),
    documentCount: integer('document_count').notNull().default(0),
    uploadCountToday: integer('upload_count_today').notNull().default(0),
    /** Day the daily counter refers to, so it can be reset lazily. */
    uploadCountDate: text('upload_count_date'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('storage_usage_user_uq').on(t.userId)],
);
