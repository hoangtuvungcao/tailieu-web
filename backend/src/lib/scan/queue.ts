import { and, eq, inArray } from 'drizzle-orm';

import { db } from '../../db/client.js';
import { redis } from '../../db/redis.js';
import { documentFiles } from '../../db/schema/index.js';

/**
 * Virus scan queue.
 *
 * A separate Redis list from the preview queue, not a shared one with a type
 * discriminator. The two have different failure semantics — a failed
 * conversion degrades to "no preview", while a failed scan must NOT silently
 * let a file through — and mixing them means one worker's error handling
 * applies to both.
 */

const QUEUE_KEY = 'scan:queue';
const PROCESSING_KEY = 'scan:processing';
const DEAD_LETTER_KEY = 'scan:dead';

/** Exposed so the worker can block on this and the preview queue at once. */
export const SCAN_QUEUE_KEY = QUEUE_KEY;

export interface ScanJob {
  fileId: string;
  documentId: string;
  bucket: string;
  objectKey: string;
  originalName: string;
  sizeBytes: number;
  attempt: number;
  enqueuedAt: string;
}

export async function enqueueScan(job: Omit<ScanJob, 'attempt' | 'enqueuedAt'>): Promise<void> {
  await redis.lpush(
    QUEUE_KEY,
    JSON.stringify({ ...job, attempt: 1, enqueuedAt: new Date().toISOString() }),
  );
}

export async function requeueScan(job: ScanJob): Promise<void> {
  await redis.lpush(
    QUEUE_KEY,
    JSON.stringify({ ...job, attempt: job.attempt + 1, enqueuedAt: new Date().toISOString() }),
  );
}

export async function deadLetterScan(job: ScanJob, reason: string): Promise<void> {
  await redis.lpush(
    DEAD_LETTER_KEY,
    JSON.stringify({ ...job, reason, failedAt: new Date().toISOString() }),
  );
  await redis.ltrim(DEAD_LETTER_KEY, 0, 499);
}

/**
 * Decode a popped payload.
 *
 * A malformed payload is unprocessable; dropping it is better than crashing the
 * worker and wedging the whole queue behind one bad entry.
 */
export function decodeScanJob(payload: string): ScanJob | null {
  try {
    return JSON.parse(payload) as ScanJob;
  } catch {
    console.error('[scan] discarding unparseable job payload');
    return null;
  }
}

/**
 * Files whose scan never happened because the scanner was switched off.
 *
 * A job can only be enqueued while scanning is on, so anything still sitting in
 * the queue when it is turned off was queued by a configuration that no longer
 * applies. Those files are stuck: their row says `pending`, and `pending` is
 * not downloadable, so they would stay invisible to every reader forever with
 * nothing reporting a problem.
 *
 * Draining them is the operator's stated intent made true — the same intent the
 * upload path already honours when it writes `ready` at attach time. Only
 * `pending` rows move; a file that failed a scan keeps its failed verdict
 * rather than being quietly resurrected.
 */
export async function drainScanQueueWhenDisabled(): Promise<number> {
  const payloads = await redis.lrange(QUEUE_KEY, 0, -1);
  if (payloads.length === 0) return 0;

  const fileIds = payloads
    .map((payload) => decodeScanJob(payload)?.fileId)
    .filter((id): id is string => Boolean(id));

  if (fileIds.length > 0) {
    await db
      .update(documentFiles)
      .set({ status: 'ready', scanStatus: 'skipped' })
      .where(and(inArray(documentFiles.id, fileIds), eq(documentFiles.status, 'pending')));
  }

  await redis.del(QUEUE_KEY);
  return fileIds.length;
}

export async function markScanProcessing(job: ScanJob): Promise<void> {
  await redis.lpush(PROCESSING_KEY, JSON.stringify(job));
}

export async function markScanProcessed(job: ScanJob): Promise<void> {
  await redis.lrem(PROCESSING_KEY, 0, JSON.stringify(job));
}

/**
 * Recover jobs whose worker died mid-scan.
 *
 * A file left in `scan_status = 'processing'` forever is the worst state to
 * debug: nothing errors, the file simply never becomes downloadable.
 */
export async function recoverStaleScanJobs(): Promise<number> {
  const stale = await redis.lrange(PROCESSING_KEY, 0, -1);
  let recovered = 0;
  for (const payload of stale) {
    try {
      await requeueScan(JSON.parse(payload) as ScanJob);
      recovered += 1;
    } catch {
      // Unparseable; drop it.
    }
  }
  if (stale.length > 0) await redis.del(PROCESSING_KEY);
  return recovered;
}

export async function scanQueueDepth(): Promise<{ pending: number; processing: number; dead: number }> {
  const [pending, processing, dead] = await Promise.all([
    redis.llen(QUEUE_KEY),
    redis.llen(PROCESSING_KEY),
    redis.llen(DEAD_LETTER_KEY),
  ]);
  return { pending, processing, dead };
}
