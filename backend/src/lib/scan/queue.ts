import { redis } from '../../db/redis.js';

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

export async function claimScanJob(): Promise<ScanJob | null> {
  // RPOP, not BRPOP.
  //
  // The Redis client sets `commandTimeout: 2000` so a slow cache read
  // cannot stall a request. A blocking pop with a timeout longer than
  // that is killed by the command timeout first — so an IDLE worker
  // logged 'Command timed out' every two seconds and processed nothing.
  // It only ever appeared to work when jobs were already waiting, because
  // a blocking pop returns immediately on a non-empty list.
  //
  // Polling once a second costs nothing and removes the coupling.
  const payload = await redis.rpop(QUEUE_KEY);
  if (!payload) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return null;
  }
  try {
    return JSON.parse(payload) as ScanJob;
  } catch {
    console.error('[scan] discarding unparseable job payload');
    return null;
  }
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
