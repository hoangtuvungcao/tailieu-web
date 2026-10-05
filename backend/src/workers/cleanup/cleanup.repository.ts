import { and, eq, inArray, lt, or, sql } from 'drizzle-orm';

import { db } from '../../db/client.js';
import {
  authTokens,
  refreshTokens,
  sessions,
  storageObjects,
  uploadChunks,
  uploadSessions,
} from '../../db/schema/index.js';

/**
 * Maintenance queries.
 *
 * Direct SQL is appropriate here in a way it is not in feature modules: these
 * are storage-hygiene operations with no domain rules to protect, and they run
 * unattended. Keeping them in one file makes the whole blast radius of the
 * cleanup job readable at once — which matters, because one of them deletes
 * bytes.
 */

/**
 * Upload sessions that expired without completing.
 *
 * These are the most important thing this job handles. An abandoned chunked
 * upload leaves an S3 multipart upload behind, and multipart parts are
 * **invisible to object listings** and not billed as objects — so they
 * accumulate silently and consume disk forever. Nothing else in the system will
 * ever notice them.
 */
export async function findExpiredUploadSessions(limit = 100) {
  return db
    .select({
      id: uploadSessions.id,
      s3UploadId: uploadSessions.s3UploadId,
      stagingKey: uploadSessions.stagingKey,
      userId: uploadSessions.userId,
      createdAt: uploadSessions.createdAt,
    })
    .from(uploadSessions)
    .where(
      and(
        inArray(uploadSessions.status, ['pending', 'assembling']),
        lt(uploadSessions.expiresAt, new Date()),
      ),
    )
    .orderBy(uploadSessions.expiresAt)
    .limit(limit);
}

export async function markUploadExpired(sessionId: string, reason: string): Promise<void> {
  await db
    .update(uploadSessions)
    .set({ status: 'expired', failureReason: reason, updatedAt: new Date() })
    .where(eq(uploadSessions.id, sessionId));
}

export async function deleteUploadChunks(sessionId: string): Promise<void> {
  await db.delete(uploadChunks).where(eq(uploadChunks.sessionId, sessionId));
}

/**
 * Expired and long-revoked refresh tokens.
 *
 * The `token_hash` unique index grows forever otherwise. A table with ten
 * million dead rows makes the login path slow exactly when nobody can afford to
 * debug it — and the useful forensic record lives in `audit_logs`, not here.
 *
 * Rotation means one session produces a row per refresh, so on an active
 * deployment this is by far the fastest-growing table in the schema.
 */
export async function countPurgeableRefreshTokens(olderThanDays: number): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(refreshTokens)
    .where(
      or(
        lt(refreshTokens.expiresAt, cutoff),
        and(
          sql`${refreshTokens.revokedAt} IS NOT NULL`,
          lt(refreshTokens.revokedAt, cutoff),
        ),
      ),
    );
  return Number(row?.value ?? 0);
}

export async function purgeRefreshTokens(olderThanDays: number): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);

  const deleted = await db
    .delete(refreshTokens)
    .where(
      or(
        // Expired well past any grace window.
        lt(refreshTokens.expiresAt, cutoff),
        // Revoked long ago; the audit trail already records why.
        and(
          sql`${refreshTokens.revokedAt} IS NOT NULL`,
          lt(refreshTokens.revokedAt, cutoff),
        ),
      ),
    )
    .returning({ id: refreshTokens.id });

  return deleted.length;
}

/** Consumed or expired email-verification and password-reset tokens. */
export async function purgeAuthTokens(olderThanDays: number): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);

  const deleted = await db
    .delete(authTokens)
    .where(
      or(
        lt(authTokens.expiresAt, cutoff),
        and(sql`${authTokens.consumedAt} IS NOT NULL`, lt(authTokens.consumedAt, cutoff)),
      ),
    )
    .returning({ id: authTokens.id });

  return deleted.length;
}

/**
 * Sessions that ended long enough ago to stop tracking.
 *
 * A session is definitely dead if either condition holds, and each is
 * independently sufficient:
 *
 *   - it expired well before the cutoff (the absolute deadline has passed), or
 *   - it was revoked well before the cutoff (logout, reuse detection, admin)
 *
 * Neither can describe a live session: `expiresAt` is an absolute deadline set
 * at creation and never extended, and a revoked session is dead by definition
 * regardless of how much of its lifetime remains.
 *
 * An earlier version of this query also required `revoked_at IS NULL`, intended
 * as caution against deleting a live session. That clause made the revoked
 * branch **unreachable** — it demanded `revoked_at IS NOT NULL` and
 * `revoked_at IS NULL` at once — so revoked sessions were never purged at all
 * and accumulated indefinitely. The predicate asserted the opposite of what it
 * did, and no error surfaced: the table simply grew.
 *
 * Deleting a session cascades to its refresh tokens via the foreign key, which
 * is why token retention is measured independently and this cutoff is longer.
 */
export async function purgeDeadSessions(olderThanDays: number): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);

  const deleted = await db
    .delete(sessions)
    .where(
      or(
        lt(sessions.expiresAt, cutoff),
        and(sql`${sessions.revokedAt} IS NOT NULL`, lt(sessions.revokedAt, cutoff)),
      ),
    )
    .returning({ id: sessions.id });

  return deleted.length;
}

/**
 * Storage objects nothing references.
 *
 * `ref_count = 0` alone is NOT sufficient to conclude an object is garbage.
 * The count is incremented in the same transaction as the `document_files`
 * insert, so a zero means either a genuine orphan (uploaded, never attached; or
 * every document using it was purged) **or** an upload that completed a moment
 * ago and whose attach transaction has not committed yet.
 *
 * That is why this query requires an age threshold. Deleting a fresh zero-count
 * object would destroy a file the user is about to see appear in their library.
 */
export async function findOrphanedObjects(olderThanHours: number, limit = 500) {
  const cutoff = new Date(Date.now() - olderThanHours * 3_600_000);

  return db
    .select({
      contentHash: storageObjects.contentHash,
      objectKey: storageObjects.objectKey,
      bucket: storageObjects.bucket,
      sizeBytes: storageObjects.sizeBytes,
      detectedMime: storageObjects.detectedMime,
      createdAt: storageObjects.createdAt,
    })
    .from(storageObjects)
    .where(and(eq(storageObjects.refCount, 0), lt(storageObjects.createdAt, cutoff)))
    .orderBy(storageObjects.createdAt)
    .limit(limit);
}

export async function deleteStorageObjectRow(contentHash: Buffer): Promise<void> {
  await db.delete(storageObjects).where(eq(storageObjects.contentHash, contentHash));
}

/** Aggregate storage figures for the admin dashboard. */
export async function storageSummary() {
  const [row] = await db
    .select({
      totalObjects: sql<number>`count(*)::int`,
      totalBytes: sql<number>`COALESCE(SUM(size_bytes), 0)::bigint`,
      orphaned: sql<number>`count(*) FILTER (WHERE ref_count = 0)::int`,
      shared: sql<number>`count(*) FILTER (WHERE ref_count > 1)::int`,
    })
    .from(storageObjects);

  return {
    totalObjects: Number(row?.totalObjects ?? 0),
    totalBytes: Number(row?.totalBytes ?? 0),
    orphaned: Number(row?.orphaned ?? 0),
    // Objects referenced by more than one document — proof that dedup is
    // actually saving space, rather than a claim nobody has verified.
    shared: Number(row?.shared ?? 0),
  };
}
