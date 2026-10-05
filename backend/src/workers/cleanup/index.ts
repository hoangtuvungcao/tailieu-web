import { env } from '../../config/env.js';
import { closeDatabase, db } from '../../db/client.js';
import { closeRedis } from '../../db/redis.js';
import { getStorage } from '../../lib/storage/index.js';
import * as repo from './cleanup.repository.js';

/**
 * Maintenance worker.
 *
 * Run from cron. Four jobs, in order of how much they matter:
 *
 *   1. REAP ABANDONED UPLOADS — the only one that fixes something otherwise
 *      invisible. A chunked upload that stops halfway leaves an S3 multipart
 *      upload behind, and multipart parts do not appear in object listings and
 *      are not billed as objects. Nothing else in the entire system will ever
 *      notice them; they just consume disk.
 *
 *   2. PURGE EXPIRED TOKENS — the fastest-growing table in the schema. Rotation
 *      writes a row per refresh, so an active deployment accumulates them
 *      steadily. A table with millions of dead rows makes login slow exactly
 *      when nobody can afford to debug it.
 *
 *   3. PRUNE DEAD SESSIONS — so the "active devices" list stays meaningful.
 *
 *   4. FIND ORPHANED OBJECTS — REPORTS BY DEFAULT. Deleting is opt-in.
 *
 * Why orphan deletion is opt-in: it is the only operation in this file that
 * destroys user-visible data, and `ref_count = 0` is not by itself proof that an
 * object is garbage — an upload that completed seconds ago may simply be
 * waiting for its attach transaction to commit. The job therefore requires both
 * an explicit flag AND an age threshold, and defaults to telling you what it
 * found. Deleting bytes automatically with a wrong assumption is not a bug you
 * recover from.
 *
 * Usage:
 *   npm run cleanup                      # everything except orphan deletion
 *   npm run cleanup -- --delete-orphans  # also delete orphans older than 24h
 *   npm run cleanup -- --dry-run         # report only, change nothing
 *   npm run cleanup -- --loop            # stay resident, run every 6 hours
 */

interface CleanupOptions {
  deleteOrphans: boolean;
  dryRun: boolean;
  orphanGraceHours: number;
  tokenRetentionDays: number;
  sessionRetentionDays: number;
}

const DEFAULT_OPTIONS: CleanupOptions = {
  deleteOrphans: false,
  dryRun: false,
  // 24 hours. Long enough that an upload whose attach is slow, or a user who
  // uploads and then walks away mid-form, is never caught.
  orphanGraceHours: 24,
  // 7 days past expiry. Any client that has not refreshed in a week is gone.
  tokenRetentionDays: 7,
  sessionRetentionDays: 30,
};

function log(message: string, meta: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), service: 'cleanup', message, ...meta }));
}

function parseArgs(argv: string[]): CleanupOptions {
  const options = { ...DEFAULT_OPTIONS };
  for (const arg of argv) {
    if (arg === '--delete-orphans') options.deleteOrphans = true;
    if (arg === '--dry-run') options.dryRun = true;
    const grace = /^--orphan-grace-hours=(\d+)$/.exec(arg);
    if (grace) options.orphanGraceHours = Number(grace[1]);
    const retention = /^--token-retention-days=(\d+)$/.exec(arg);
    if (retention) options.tokenRetentionDays = Number(retention[1]);
  }
  return options;
}

interface CleanupReport {
  uploadsReaped: number;
  uploadsFailed: number;
  refreshTokensPurged: number;
  authTokensPurged: number;
  sessionsPurged: number;
  orphansFound: number;
  orphansDeleted: number;
  orphanBytes: number;
  storage: Awaited<ReturnType<typeof repo.storageSummary>>;
  durationMs: number;
}

/**
 * Abort multipart uploads for sessions that expired without completing.
 *
 * Aborting the storage-side upload is the critical part. Marking the row
 * `expired` without aborting would leave the parts on disk forever while the
 * database cheerfully reports a clean state — the worst combination, because
 * the leak becomes undetectable through the application.
 */
async function reapAbandonedUploads(
  options: CleanupOptions,
  report: CleanupReport,
): Promise<void> {
  const sessions = await repo.findExpiredUploadSessions();

  if (sessions.length === 0) return;

  log('abandoned upload sessions found', { count: sessions.length });

  const storage = getStorage();

  for (const session of sessions) {
    if (options.dryRun) {
      report.uploadsReaped += 1;
      continue;
    }

    try {
      await storage.abortMultipartUpload({
        bucket: env.S3_BUCKET,
        key: session.stagingKey,
        uploadId: session.s3UploadId,
      });
    } catch (error) {
      // NoSuchUpload is the expected outcome when the storage backend already
      // expired the upload via its own lifecycle rule. That is success, not
      // failure — but any other error means the parts may still be there, and
      // the session must NOT be marked expired or the leak becomes invisible.
      const message = (error as Error).message ?? '';
      if (!/NoSuchUpload|not found|does not exist/i.test(message)) {
        log('could not abort multipart upload; leaving the session pending', {
          sessionId: session.id,
          detail: message,
        });
        report.uploadsFailed += 1;
        continue;
      }
    }

    await repo.deleteUploadChunks(session.id);
    await repo.markUploadExpired(session.id, 'abandoned; multipart upload aborted');
    report.uploadsReaped += 1;
  }
}

async function purgeTokens(options: CleanupOptions, report: CleanupReport): Promise<void> {
  const pending = await repo.countPurgeableRefreshTokens(options.tokenRetentionDays);
  log('tokens eligible for purge', { refreshTokens: pending, olderThanDays: options.tokenRetentionDays });

  if (options.dryRun) {
    report.refreshTokensPurged = pending;
    return;
  }

  report.refreshTokensPurged = await repo.purgeRefreshTokens(options.tokenRetentionDays);
  report.authTokensPurged = await repo.purgeAuthTokens(options.tokenRetentionDays);
  report.sessionsPurged = await repo.purgeDeadSessions(options.sessionRetentionDays);
}

/**
 * Report storage objects nothing references, and optionally delete them.
 *
 * The report runs even in dry-run mode, because knowing how much space is
 * orphaned is useful on its own — it is how you notice that deduplication broke
 * or that a delete path stopped decrementing reference counts.
 */
async function handleOrphans(options: CleanupOptions, report: CleanupReport): Promise<void> {
  const orphans = await repo.findOrphanedObjects(options.orphanGraceHours);

  report.orphansFound = orphans.length;
  report.orphanBytes = orphans.reduce((sum, o) => sum + Number(o.sizeBytes), 0);

  if (orphans.length === 0) return;

  const megabytes = Math.round(report.orphanBytes / (1024 * 1024));
  log('orphaned storage objects', {
    count: orphans.length,
    megabytes,
    olderThanHours: options.orphanGraceHours,
    action: options.deleteOrphans && !options.dryRun ? 'deleting' : 'reporting only',
  });

  if (!options.deleteOrphans || options.dryRun) {
    if (!options.deleteOrphans) {
      log('orphan deletion is opt-in; pass --delete-orphans to reclaim this space');
    }
    return;
  }

  const storage = getStorage();

  for (const orphan of orphans) {
    try {
      // Object first, then the row. The reverse order would leave a row
      // pointing at bytes that are gone — which surfaces to a user as a
      // document whose download 404s.
      await storage.deleteObject({ bucket: orphan.bucket, key: orphan.objectKey });
      await repo.deleteStorageObjectRow(orphan.contentHash);
      report.orphansDeleted += 1;
    } catch (error) {
      log('could not delete orphaned object; leaving it for the next run', {
        objectKey: orphan.objectKey,
        detail: (error as Error).message,
      });
    }
  }
}

export async function runCleanup(options: CleanupOptions): Promise<CleanupReport> {
  const started = Date.now();

  const report: CleanupReport = {
    uploadsReaped: 0,
    uploadsFailed: 0,
    refreshTokensPurged: 0,
    authTokensPurged: 0,
    sessionsPurged: 0,
    orphansFound: 0,
    orphansDeleted: 0,
    orphanBytes: 0,
    storage: { totalObjects: 0, totalBytes: 0, orphaned: 0, shared: 0 },
    durationMs: 0,
  };

  log('cleanup starting', { ...options });

  // Order matters: reap uploads before looking for orphans, so an object
  // belonging to a just-aborted upload is not misreported as an orphan in the
  // same run.
  await reapAbandonedUploads(options, report);
  await purgeTokens(options, report);
  await handleOrphans(options, report);

  report.storage = await repo.storageSummary();
  report.durationMs = Date.now() - started;

  log('cleanup finished', {
    ...report,
    totalMegabytes: Math.round(report.storage.totalBytes / (1024 * 1024)),
  });

  return report;
}

// --- Entry point -------------------------------------------------------------

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const loopMode = process.argv.includes('--loop');

  if (!loopMode) {
    await runCleanup(options);
    return;
  }

  // Resident mode for a host without cron. Six hours: frequent enough that an
  // abandoned upload's parts do not sit around for long, rare enough to be
  // invisible on a laptop.
  const INTERVAL_MS = 6 * 60 * 60 * 1000;
  let shuttingDown = false;

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('shutting down', { signal });
    void (async () => {
      await closeDatabase().catch(() => undefined);
      await closeRedis().catch(() => undefined);
      process.exit(0);
    })();
  };

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => shutdown(signal));
  }

  while (!shuttingDown) {
    try {
      await runCleanup(options);
    } catch (error) {
      // A failed run must not kill the loop: the next one may succeed, and a
      // resident process that exits on the first transient database error is
      // worse than useless.
      log('cleanup run failed', { detail: (error as Error).message });
    }

    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }
}

main()
  .then(async () => {
    await closeDatabase();
    await closeRedis();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    log('cleanup crashed', { detail: (error as Error).message });
    await closeDatabase().catch(() => undefined);
    await closeRedis().catch(() => undefined);
    process.exit(1);
  });
