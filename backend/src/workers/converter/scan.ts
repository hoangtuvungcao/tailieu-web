import { eq, sql } from 'drizzle-orm';

import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import { documentFiles } from '../../db/schema/index.js';
import { recordAudit } from '../../lib/audit.js';
import { pingClamd, scanStream, type ScanVerdict } from '../../lib/scan/clamd.client.js';
import {
  deadLetterScan,
  markScanProcessed,
  markScanProcessing,
  recoverStaleScanJobs,
  requeueScan,
  type ScanJob,
} from '../../lib/scan/queue.js';
import { getStorage } from '../../lib/storage/index.js';

/**
 * Virus scanning.
 *
 * The governing rule: **a file that has not been cleared is not downloadable.**
 * `document_files.status` stays `pending` until a verdict arrives, and
 * `getDownloadUrl` already refuses anything that is not `ready` — so the gate
 * exists without touching the download path at all.
 *
 * The failure modes are the interesting part, and each resolves the same way —
 * toward *not* serving the file:
 *
 *   infected        -> status failed, file never served, uploader notified
 *   daemon down     -> retry, then dead-letter; the file stays pending
 *   too large       -> marked skipped and NOT served, because "we could not
 *                      check it" is not the same as "it is safe"
 *   scanner disabled-> marked skipped and served, because the operator chose
 *                      that explicitly and leaving every upload pending
 *                      forever would be a self-inflicted outage
 */

const MAX_ATTEMPTS = 3;

export function scanningEnabled(): boolean {
  return env.SCAN_ENABLED;
}

/** Confirm clamd is up before accepting any jobs. */
export async function assertScannerAvailable(): Promise<void> {
  if (!env.SCAN_ENABLED) return;
  const alive = await pingClamd();
  if (!alive) {
    throw new Error(
      `SCAN_ENABLED is true but clamd is not answering at ${env.CLAMAV_ADDRESS}. ` +
        'Refusing to start: accepting scan jobs with no scanner would leave every ' +
        'upload stuck as pending forever.',
    );
  }
}

export async function recoverStaleScans(): Promise<number> {
  return recoverStaleScanJobs();
}

export async function processScanJob(job: ScanJob): Promise<void> {
  if (job.sizeBytes > env.SCAN_MAX_BYTES) {
    // ClamAV would reject this at its own StreamMaxLength and we would report a
    // scan failure on a file that is merely large. Marking it explicitly means
    // the state is honest: not scanned, and therefore not served.
    await db
      .update(documentFiles)
      .set({ scanStatus: 'skipped_too_large', scannedAt: new Date() })
      .where(eq(documentFiles.id, job.fileId));
    console.warn(
      JSON.stringify({
        service: 'scanner',
        message: 'file too large to scan; leaving it unserved',
        fileId: job.fileId,
        sizeBytes: job.sizeBytes,
        limit: env.SCAN_MAX_BYTES,
      }),
    );
    return;
  }

  const storage = getStorage();
  const stream = await storage.getStream({ bucket: job.bucket, key: job.objectKey });

  let verdict: ScanVerdict;
  try {
    verdict = await scanStream(stream);
  } catch (error) {
    // Transport failure — the daemon is unreachable or died mid-stream. This
    // must NOT be treated as clean.
    throw new Error(`scan transport failed: ${(error as Error).message}`);
  }

  if (verdict.status === 'error') {
    throw new Error(verdict.reason);
  }

  if (verdict.status === 'infected') {
    await db.transaction(async (tx) => {
      // The file row keeps the signature so a moderator can see what was found
      // and the uploader can be told something specific.
      await tx
        .update(documentFiles)
        .set({
          status: 'failed',
          scanStatus: 'infected',
          scannedAt: new Date(),
        })
        .where(eq(documentFiles.id, job.fileId));

      await recordAudit(tx, {
        action: 'document.file.infected',
        actorUserId: null,
        targetType: 'document',
        targetId: job.documentId,
        metadata: {
          fileId: job.fileId,
          signature: verdict.signature,
          originalName: job.originalName,
        },
      });
    });

    console.error(
      JSON.stringify({
        service: 'scanner',
        level: 'error',
        message: 'malware detected',
        fileId: job.fileId,
        signature: verdict.signature,
        originalName: job.originalName,
      }),
    );
    return;
  }

  // Clean: this is what makes the file downloadable.
  await db
    .update(documentFiles)
    .set({ status: 'ready', scanStatus: 'clean', scannedAt: new Date() })
    .where(eq(documentFiles.id, job.fileId));

  console.log(
    JSON.stringify({ service: 'scanner', message: 'clean', fileId: job.fileId }),
  );
}

/**
 * Run one scan job, with retry and dead-lettering.
 *
 * A transport failure is retried; a *verdict* is not. Retrying an infected
 * result would be pointless, and retrying a clean one would re-download the
 * file for nothing.
 */
export async function handleScanJob(job: ScanJob): Promise<void> {
  await markScanProcessing(job);

  try {
    await processScanJob(job);
    await markScanProcessed(job);
  } catch (error) {
    const reason = (error as Error).message ?? 'unknown error';

    if (job.attempt < MAX_ATTEMPTS) {
      console.warn(
        JSON.stringify({
          service: 'scanner',
          message: 'retrying after failure',
          fileId: job.fileId,
          attempt: job.attempt,
          reason,
        }),
      );
      await requeueScan(job);
    } else {
      // Exhausted. The file stays `pending` and therefore unserved — which is
      // the correct outcome for "we could not determine whether this is safe".
      console.error(
        JSON.stringify({
          service: 'scanner',
          level: 'error',
          message: 'giving up; file remains unserved',
          fileId: job.fileId,
          attempts: job.attempt,
          reason,
        }),
      );
      await deadLetterScan(job, reason);
      await db
        .update(documentFiles)
        .set({ scanStatus: 'failed', scannedAt: new Date() })
        .where(eq(documentFiles.id, job.fileId));
    }

    await markScanProcessed(job);
  }
}

/** Mark files as scanned-by-choice when scanning is switched off. */
export async function markScanSkipped(fileId: string): Promise<void> {
  await db
    .update(documentFiles)
    .set({ scanStatus: 'skipped' })
    .where(eq(documentFiles.id, fileId));
}

/** Counters for the admin storage screen. */
export async function scanStatusCounts(): Promise<Record<string, number>> {
  const { rows } = await db.execute<{ scan_status: string; count: string }>(sql`
    SELECT scan_status, count(*)::text AS count
      FROM document_files
     WHERE deleted_at IS NULL
     GROUP BY scan_status
  `);
  return Object.fromEntries(rows.map((r) => [r.scan_status, Number(r.count)]));
}

// Re-exported so the worker entry point has a single import for scan concerns.
export { markScanProcessing, markScanProcessed };
