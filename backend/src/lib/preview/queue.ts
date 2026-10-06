import { redis } from '../../db/redis.js';

/**
 * Preview conversion queue.
 *
 * Redis lists rather than a dedicated job framework. The workload is a single
 * job type with one consumer, so a broker would add an operational dependency
 * without adding a capability — and Redis is already here for rate limiting and
 * the permission cache.
 *
 * Durability is deliberately not promised. A lost job means a missing preview,
 * not a lost document: the original is already safely in object storage and
 * Postgres, and a re-index action can requeue anything that was dropped. That
 * is a property worth stating explicitly, because it is what makes it
 * acceptable to keep this simple.
 */

const QUEUE_KEY = 'preview:queue';
const PROCESSING_KEY = 'preview:processing';
const DEAD_LETTER_KEY = 'preview:dead';

/**
 * Exposed so a consumer can block on several queues at once.
 *
 * The worker serves this queue and the scan queue from one loop, and a single
 * multi-key `BRPOP` wakes on whichever fills first — which is both lower
 * latency and cheaper than polling each in turn. That requires the key name to
 * be visible outside this module, so it is exported deliberately rather than
 * reconstructed at the call site.
 */
export const PREVIEW_QUEUE_KEY = QUEUE_KEY;

export interface PreviewJob {
  /** `document_files.id` — the specific file to convert. */
  fileId: string;
  documentId: string;
  /** Storage coordinates of the source object. */
  bucket: string;
  objectKey: string;
  originalName: string;
  detectedMime: string;
  /** Attempt number, so the worker can give up rather than loop forever. */
  attempt: number;
  enqueuedAt: string;
}

export async function enqueuePreview(job: Omit<PreviewJob, 'attempt' | 'enqueuedAt'>): Promise<void> {
  const payload: PreviewJob = { ...job, attempt: 1, enqueuedAt: new Date().toISOString() };

  // LPUSH + BRPOP gives FIFO order: the worker pops from the tail while
  // producers push to the head. RPUSH+LPOP is equivalent; mixing them by
  // accident produces LIFO, which starves the oldest jobs.
  await redis.lpush(QUEUE_KEY, JSON.stringify(payload));
}

/** Requeue a job that failed, once, with an incremented attempt count. */
export async function requeuePreview(job: PreviewJob): Promise<void> {
  await redis.lpush(
    QUEUE_KEY,
    JSON.stringify({ ...job, attempt: job.attempt + 1, enqueuedAt: new Date().toISOString() }),
  );
}

/**
 * Park a job that has exhausted its retries.
 *
 * Kept rather than discarded so an operator can see *what* failed and why,
 * which is impossible if the only record is a log line from hours ago.
 */
export async function deadLetterPreview(job: PreviewJob, reason: string): Promise<void> {
  await redis.lpush(DEAD_LETTER_KEY, JSON.stringify({ ...job, reason, failedAt: new Date().toISOString() }));
  // Bound the dead-letter list so a systematic failure cannot fill Redis.
  await redis.ltrim(DEAD_LETTER_KEY, 0, 499);
}

/**
 * Decode a popped payload.
 *
 * A malformed payload is unprocessable; dropping it is better than crashing the
 * worker and wedging the whole queue behind one bad entry.
 */
export function decodePreviewJob(payload: string): PreviewJob | null {
  try {
    return JSON.parse(payload) as PreviewJob;
  } catch {
    console.error('[converter] discarding unparseable job payload');
    return null;
  }
}

/**
 * Recover jobs whose worker died mid-conversion.
 *
 * Called at startup so a container restart does not strand work — without this,
 * a job claimed by a process that was killed is lost silently and the file
 * stays in `processing` forever, which is the worst state to debug because
 * nothing appears broken.
 */
export async function recoverStaleJobs(): Promise<number> {
  const stale = await redis.lrange(PROCESSING_KEY, 0, -1);
  let recovered = 0;

  for (const payload of stale) {
    try {
      const job = JSON.parse(payload) as PreviewJob;
      await requeuePreview(job);
      recovered += 1;
    } catch {
      // Unparseable; drop it.
    }
  }

  if (stale.length > 0) await redis.del(PROCESSING_KEY);
  return recovered;
}

export async function markProcessing(payload: PreviewJob): Promise<void> {
  await redis.lpush(PROCESSING_KEY, JSON.stringify(payload));
}

export async function markProcessed(payload: PreviewJob): Promise<void> {
  await redis.lrem(PROCESSING_KEY, 0, JSON.stringify(payload));
}

export async function queueDepth(): Promise<{ pending: number; processing: number; dead: number }> {
  const [pending, processing, dead] = await Promise.all([
    redis.llen(QUEUE_KEY),
    redis.llen(PROCESSING_KEY),
    redis.llen(DEAD_LETTER_KEY),
  ]);
  return { pending, processing, dead };
}

/** Operator action: move dead-lettered jobs back onto the queue. */
export async function retryDeadLetters(limit = 50): Promise<number> {
  let requeued = 0;
  for (let i = 0; i < limit; i += 1) {
    const payload = await redis.rpop(DEAD_LETTER_KEY);
    if (!payload) break;
    try {
      const job = JSON.parse(payload) as PreviewJob;
      await redis.lpush(QUEUE_KEY, JSON.stringify({ ...job, attempt: 1 }));
      requeued += 1;
    } catch {
      // Drop unparseable entries rather than pushing them back.
    }
  }
  return requeued;
}
