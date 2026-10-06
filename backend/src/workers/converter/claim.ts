import { redisBlocking } from '../../db/redis.js';
import { decodePreviewJob, PREVIEW_QUEUE_KEY, type PreviewJob } from '../../lib/preview/queue.js';
import { decodeScanJob, SCAN_QUEUE_KEY, type ScanJob } from '../../lib/scan/queue.js';

/**
 * Claim the next job from either queue.
 *
 * Why one multi-key `BRPOP` rather than two sequential blocking pops:
 *
 * The worker serves two queues from a single serial loop. Popping them in turn
 * means whichever is asked second waits out the first one's full timeout while
 * it blocks — so a scan job arriving during a preview pop sits for seconds
 * before anyone notices it. Redis's multi-key `BRPOP` returns as soon as *any*
 * listed key has an element, so both queues are served with one round trip and
 * neither waits on the other's idle time.
 *
 * Argument order is the priority order: when both queues hold work Redis pops
 * the first key listed. Scanning goes first on purpose. A file that has not
 * been cleared is not downloadable, so a queued scan is blocking a user right
 * now, while a missing preview only means a less rich page.
 */

export type ClaimedJob =
  | { kind: 'scan'; job: ScanJob }
  | { kind: 'preview'; job: PreviewJob };

/**
 * @param scanning Whether the scanner is switched on. When it is off the scan
 *   queue is left alone rather than drained — the caller handles that case once
 *   at startup, and popping here would only feed the loop jobs it must not run.
 */
export async function claimNextJob(
  scanning: boolean,
  timeoutSeconds = 5,
): Promise<ClaimedJob | null> {
  const keys = scanning ? [SCAN_QUEUE_KEY, PREVIEW_QUEUE_KEY] : [PREVIEW_QUEUE_KEY];

  // `brpop(key, ..., timeout)` — the last argument is the timeout, never a key.
  const result = await redisBlocking.brpop(...keys, timeoutSeconds);
  if (!result) return null;

  const [key, payload] = result as [string, string];

  if (key === SCAN_QUEUE_KEY) {
    const job = decodeScanJob(payload);
    return job ? { kind: 'scan', job } : null;
  }

  const job = decodePreviewJob(payload);
  return job ? { kind: 'preview', job } : null;
}
