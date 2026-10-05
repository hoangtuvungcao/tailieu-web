import { Readable } from 'node:stream';

import { eq } from 'drizzle-orm';

import { env } from '../../config/env.js';
import { closeDatabase, db } from '../../db/client.js';
import { closeRedis } from '../../db/redis.js';
import { documentFiles, storageObjects } from '../../db/schema/index.js';
import { buildDerivedKey } from '../../lib/files/mime.js';
import {
  claimPreviewJob,
  deadLetterPreview,
  markProcessed,
  markProcessing,
  queueDepth,
  recoverStaleJobs,
  requeuePreview,
  type PreviewJob,
} from '../../lib/preview/queue.js';
import { getStorage } from '../../lib/storage/index.js';
import { checkConverterAvailable, ConversionError, convertToPdf } from './convert.js';
import {
  assertScannerAvailable,
  handleScanJob,
  recoverStaleScans,
  scanningEnabled,
} from './scan.js';
import { claimScanJob } from '../../lib/scan/queue.js';

/**
 * Preview conversion worker.
 *
 * Runs as its own container so a runaway conversion cannot take the API down:
 * LibreOffice is memory-hungry, occasionally hangs, and opens untrusted
 * documents for a living. Isolating it means the worst case is a stalled
 * preview, not a stalled login.
 *
 * The loop is intentionally simple — claim, convert, persist — because the
 * failure modes that matter are handled by states rather than by machinery:
 * a failed job is requeued once and then dead-lettered, and a job whose worker
 * died is recovered at startup. Anything more elaborate would be a job
 * framework, and the case for one does not exist at this scale.
 */

const MAX_ATTEMPTS = 2;
/* Poll interval lives in the queue module; see the note on RPOP there. */

let shuttingDown = false;
let currentJob: PreviewJob | null = null;

function log(message: string, meta: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify({ ts: new Date().toISOString(), service: 'converter', message, ...meta }),
  );
}

function error(message: string, meta: Record<string, unknown> = {}): void {
  console.error(
    JSON.stringify({ ts: new Date().toISOString(), service: 'converter', level: 'error', message, ...meta }),
  );
}

/**
 * Convert one file and persist the result.
 *
 * Steps are ordered so that nothing becomes visible until it is complete: the
 * PDF is uploaded and its storage row written BEFORE the file row is updated
 * to `ready`. The reverse order would briefly advertise a preview whose object
 * does not exist, and a user clicking in that window gets a 404 from a link
 * the API just handed them.
 */
async function processJob(job: PreviewJob): Promise<void> {
  const storage = getStorage();

  // --- Fetch the source ---------------------------------------------------
  const sourceStream = await storage.getStream({ bucket: job.bucket, key: job.objectKey });
  const chunks: Buffer[] = [];
  for await (const chunk of sourceStream) {
    chunks.push(chunk as Buffer);
  }
  const source = Buffer.concat(chunks);

  log('converting', {
    fileId: job.fileId,
    mime: job.detectedMime,
    bytes: source.length,
    attempt: job.attempt,
  });

  // --- Convert ------------------------------------------------------------
  const { buffer, durationMs } = await convertToPdf(source, job.originalName);

  // --- Upload the artifact ------------------------------------------------
  // `.preview.pdf` suffix on a derived key rather than a fresh random key, so
  // an operator looking at the bucket can tell at a glance which objects are
  // originals and which are generated.
  const previewKey = buildDerivedKey(job.objectKey, 'preview', 'pdf');
  const upload = await storage.putStream({
    bucket: env.S3_BUCKET,
    key: previewKey,
    body: Readable.from([buffer]),
    contentType: 'application/pdf',
    metadata: { derivedFrom: job.fileId, generator: 'libreoffice' },
  });

  const contentHash = Buffer.from(upload.contentHash, 'hex');

  // --- Persist ------------------------------------------------------------
  await db.transaction(async (tx) => {
    // The artifact needs a storage_objects row so the existing signed-URL path
    // works for it unchanged, and so the reaper can see it. ref_count stays 0:
    // nothing *references* a preview the way a document references a file, and
    // the file row's FK is what keeps it alive.
    await tx
      .insert(storageObjects)
      .values({
        contentHash,
        bucket: env.S3_BUCKET,
        objectKey: previewKey,
        sizeBytes: upload.sizeBytes,
        detectedMime: 'application/pdf',
        refCount: 0,
      })
      .onConflictDoNothing({ target: storageObjects.contentHash });

    await tx
      .update(documentFiles)
      .set({
        previewContentHash: contentHash,
        previewStatus: 'ready',
        previewError: null,
      })
      .where(eq(documentFiles.id, job.fileId));
  });

  log('converted', {
    fileId: job.fileId,
    durationMs,
    pdfBytes: upload.sizeBytes,
    ratio: `${Math.round((upload.sizeBytes / Math.max(source.length, 1)) * 100)}%`,
  });
}

async function handleFailure(job: PreviewJob, reason: string): Promise<void> {
  await db
    .update(documentFiles)
    .set({ previewStatus: 'failed', previewError: reason.slice(0, 500) })
    .where(eq(documentFiles.id, job.fileId))
    .catch(() => undefined);

  if (job.attempt < MAX_ATTEMPTS) {
    log('requeueing after failure', { fileId: job.fileId, attempt: job.attempt, reason });
    await requeuePreview(job);
  } else {
    error('giving up on preview', { fileId: job.fileId, attempts: job.attempt, reason });
    await deadLetterPreview(job, reason);
  }
}

async function main(): Promise<void> {
  const availability = await checkConverterAvailable();
  if (!availability.ok) {
    // Fail fast. A worker that starts without soffice will accept jobs, fail
    // every one of them, and dead-letter the entire queue — much worse than
    // refusing to start, which is visible immediately.
    error('LibreOffice is not available; refusing to start', { detail: availability.detail });
    process.exit(1);
  }

  log('converter ready', { libreoffice: availability.detail, concurrency: 1 });

  // Scanner, when enabled. Fails the whole worker rather than accepting jobs
  // it cannot process — a queue that grows while nothing completes looks
  // healthy and is the hardest state to diagnose.
  if (scanningEnabled()) {
    try {
      await assertScannerAvailable();
      const recoveredScans = await recoverStaleScans();
      log('scanner ready', { recovered: recoveredScans });
    } catch (scanError) {
      error('scanner unavailable; refusing to start', {
        detail: (scanError as Error).message,
      });
      process.exit(1);
    }
  }

  const recovered = await recoverStaleJobs();
  if (recovered > 0) {
    log('recovered jobs from a previous run', { count: recovered });
  }

  // A health beacon so `docker ps` and the admin panel can see the worker is
  // alive, and how far behind it is.
  const heartbeat = setInterval(() => {
    void queueDepth()
      .then((depth) => log('heartbeat', { ...depth, current: currentJob?.fileId ?? null }))
      .catch(() => undefined);
  }, 60_000);
  heartbeat.unref();

  // Serial processing. LibreOffice conversion is CPU-bound and this runs on a
  // laptop; running conversions in parallel would make every one of them slower
  // and risk memory exhaustion. CONVERTER_CONCURRENCY is a documented setting,
  // and the honest answer is that it should stay at 1 on this hardware.
  while (!shuttingDown) {
    // Scan jobs first. A file that has not been cleared is not downloadable, so
    // scanning is on the critical path in a way that conversion is not —
    // a missing preview degrades the experience, a missing scan blocks it.
    if (scanningEnabled()) {
      try {
        const scanJob = await claimScanJob();
        if (scanJob) {
          await handleScanJob(scanJob);
          continue;
        }
      } catch (scanError) {
        error('scan job failed', { detail: (scanError as Error).message });
      }
    }

    let job: PreviewJob | null = null;

    try {
      job = await claimPreviewJob();
    } catch (claimError) {
      // Redis unreachable. Back off rather than spinning — a tight retry loop
      // against a downed Redis is a busy-wait that burns CPU on a laptop.
      error('could not claim a job; backing off', {
        detail: (claimError as Error).message,
      });
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      continue;
    }

    if (!job) continue;

    currentJob = job;
    await markProcessing(job);

    try {
      await processJob(job);
      await markProcessed(job);
    } catch (jobError) {
      const reason =
        jobError instanceof ConversionError
          ? jobError.message
          : ((jobError as Error).message ?? 'unknown error');
      await handleFailure(job, reason);
      await markProcessed(job);
    } finally {
      currentJob = null;
    }
  }

  clearInterval(heartbeat);
  log('converter stopped');
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log('shutting down', { signal, inFlight: currentJob?.fileId ?? null });

  // A conversion in progress is allowed to finish: killing it mid-way would
  // leave the job in `processing` and the file permanently un-previewable
  // until the next restart's recovery pass.
  const deadline = Date.now() + 30_000;
  while (currentJob && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  await closeDatabase().catch(() => undefined);
  await closeRedis().catch(() => undefined);
  process.exit(0);
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => void shutdown(signal));
}

process.on('unhandledRejection', (reason) => {
  error('unhandled rejection', { detail: String(reason) });
});

main().catch((err: unknown) => {
  error('worker crashed', { detail: (err as Error).message });
  process.exit(1);
});
