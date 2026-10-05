import { redis } from '../../../db/redis.js';

/**
 * Trending, on Redis sorted sets.
 *
 * WHY NOT SQL. A trending score has to decay with age, and `score / age^1.5` is
 * not IMMUTABLE — so it cannot appear in an index predicate, and `ORDER BY
 * <expression>` over a time window forces Postgres to sort the whole window on
 * every read. The list gets slower exactly as the platform gets busier.
 *
 * WHY THIS SHAPE. One `ZINCRBY` per engagement event into the bucket for the
 * current hour, then a read that unions the last 24 buckets with weights that
 * fall off with age. Nothing is recomputed on a schedule and no score is ever
 * rewritten — an event is one command, and an hour becomes irrelevant when the
 * window has moved past it.
 *
 * REDIS IS AN ACCELERATOR, NEVER A SOURCE OF TRUTH. Every read here can fail
 * and returns null, which the caller answers with a bounded SQL query. Losing
 * this data makes trending slightly staler; it must never make a page fail, and
 * it must never be the only copy of anything. Nothing user-authored lives here
 * — only post ids and a number.
 */

/** Buckets are per hour, so the window is 24 buckets. */
const BUCKET_MS = 60 * 60 * 1000;
const WINDOW_HOURS = 24;

/**
 * How long a materialised union stays usable.
 *
 * Short, because the buckets it is built from keep moving — a like in the
 * current hour genuinely should change the list within a minute or so. This is
 * what makes many concurrent readers pay for one `ZUNIONSTORE` rather than one
 * each.
 */
const UNION_TTL_SECONDS = 60;

/**
 * What an engagement is worth, in trend points.
 *
 * A comment costs more effort than a like and a bookmark is a stronger signal
 * than either, so they are not worth the same. Deliberately small integers:
 * this ordering is a hint about what to read, and a wrong-but-close number is
 * not worth a more elaborate model.
 */
export const TREND_WEIGHTS = {
  like: 1,
  bookmark: 2,
  comment: 3,
} as const;

function bucketKey(hour: number): string {
  return `trend:h:${hour}`;
}

function unionKey(hour: number): string {
  return `trend:u:${hour}`;
}

function currentHour(): number {
  return Math.floor(Date.now() / BUCKET_MS);
}

/**
 * Record one engagement against a post.
 *
 * Called AFTER the transaction that wrote the engagement, not inside it: this
 * is a network call to another service, and holding a database transaction open
 * across it is how a slow Redis becomes a lock on the posts table.
 *
 * Never throws. A lost signal costs a little accuracy in a list that is
 * explicitly a heuristic; failing the like that caused it would cost the user
 * their action.
 */
export async function recordTrendSignal(postId: string, weight: number): Promise<void> {
  try {
    const hour = currentHour();
    const key = bucketKey(hour);

    const pipeline = redis.pipeline();
    pipeline.zincrby(key, weight, postId);
    // Only read back inside the window, so a bucket that has fallen out of it
    // is waste. Two hours of slack so a bucket cannot expire mid-union.
    pipeline.expire(key, (WINDOW_HOURS + 2) * 3600);
    await pipeline.exec();
  } catch (error) {
    console.warn('[trending] could not record a signal:', (error as Error).message);
  }
}

/**
 * The current trending post ids, most active first — or null when Redis cannot
 * answer, which the caller must treat as "use the SQL fallback" rather than
 * "nothing is trending".
 *
 * The distinction matters: an empty array means nothing was engaged with in the
 * window, null means the answer is unknown. Collapsing them would turn a Redis
 * outage into a silently empty trending list.
 */
export async function topTrendingPostIds(limit: number): Promise<string[] | null> {
  try {
    const hour = currentHour();
    const dest = unionKey(hour);

    const cached = await redis.zrevrange(dest, 0, limit - 1);
    if (cached.length > 0) return cached;

    const keys: string[] = [];
    const weights: number[] = [];
    for (let age = 0; age < WINDOW_HOURS; age += 1) {
      keys.push(bucketKey(hour - age));
      // 1, 1/2, 1/3 … so an engagement this hour counts for twelve times one
      // from half a day ago, without any bucket ever being rewritten.
      weights.push(1 / (age + 1));
    }

    const pipeline = redis.pipeline();
    pipeline.zunionstore(dest, keys.length, ...keys, 'WEIGHTS', ...weights);
    pipeline.expire(dest, UNION_TTL_SECONDS);
    const results = await pipeline.exec();

    // ioredis resolves `exec` with `[error, result]` pairs rather than
    // rejecting, so a failed command inside a pipeline is not an exception. If
    // this is not checked, a broken union looks like an empty one.
    const failed = results?.find(([error]) => error);
    if (failed) throw failed[0] as Error;

    return await redis.zrevrange(dest, 0, limit - 1);
  } catch (error) {
    console.warn('[trending] falling back to SQL:', (error as Error).message);
    return null;
  }
}
