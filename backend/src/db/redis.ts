import { Redis } from 'ioredis';

import { env } from '../config/env.js';

/**
 * Redis client.
 *
 * Redis holds three kinds of state, all of which are either reconstructible or
 * expendable — which is what lets it be treated as disposable in backups:
 *
 *   1. Permission cache (rebuildable from Postgres in one query)
 *   2. Rate-limit counters (losing them briefly is acceptable)
 *   3. The Office-conversion job queue (a lost job means a missing preview,
 *      not a corrupted document — the document itself is already safe in S3
 *      and Postgres)
 *
 * No authoritative state lives here. That is a deliberate constraint: the
 * laptop running this can lose power, and nothing user-visible should be lost
 * with it.
 */
export const redis = new Redis(env.REDIS_URL, {
  // Rate limiting must not wait on a slow Redis; failing fast and degrading is
  // better than every request stalling behind a connect timeout.
  connectTimeout: 5_000,
  commandTimeout: 2_000,
  maxRetriesPerRequest: 3,
  enableOfflineQueue: true,
  lazyConnect: false,
  retryStrategy(times) {
    // Back off to at most 5s. Returning null would permanently stop retrying
    // and silently disable rate limiting and caching for the process lifetime.
    return Math.min(times * 200, 5_000);
  },
});

redis.on('error', (error: Error) => {
  // Logged, never fatal. A Redis outage degrades caching and rate limiting;
  // it must not take down authentication or document access.
  console.error('[redis] error:', error.message);
});

redis.on('connect', () => {
  console.info('[redis] connected');
});

/**
 * A second connection for blocking commands, with no `commandTimeout`.
 *
 * The client above sets a 2s command timeout so a slow Redis cannot stall an
 * HTTP request. That is right for the API and wrong for a queue consumer: a
 * blocking pop is *supposed* to sit idle, and ioredis applies `commandTimeout`
 * to blocking commands like any other. With both settings on one client,
 * `BRPOP key 5` was aborted at 2000ms with "Command timed out" — every single
 * time the queue was empty, which is nearly always. The worker logged an error
 * every eight seconds and converted nothing. It only ever looked healthy when
 * jobs were already waiting, because then the pop returns immediately.
 *
 * Blocking pops therefore need their own connection. This is the standard
 * arrangement (BullMQ and friends do the same) rather than a workaround: the
 * two clients have genuinely different latency contracts, and one socket cannot
 * honour both.
 *
 * Note the two clients share a Redis database, not state — `redis` and
 * `redisBlocking` see the same keys.
 */
export const redisBlocking = new Redis(env.REDIS_URL, {
  connectTimeout: 5_000,
  // No commandTimeout. Blocking pops are bounded by their own timeout argument
  // and by CONVERT_TIMEOUT_MS/CLAMAV_TIMEOUT_MS upstream, so an unbounded
  // command here cannot hang a consumer forever.
  //
  // `null` rather than a count: when the connection drops mid-BRPOP, queuing
  // the command for retry is what we want. A finite limit would surface as a
  // spurious job-claim failure on every network blip.
  maxRetriesPerRequest: null,
  enableOfflineQueue: true,
  lazyConnect: false,
  retryStrategy(times) {
    return Math.min(times * 200, 5_000);
  },
});

redisBlocking.on('error', (error: Error) => {
  console.error('[redis:blocking] error:', error.message);
});

/** Namespaced key builders — keeps ad-hoc string keys out of call sites. */
export const cacheKeys = {
  /** Effective permission set for a user. Invalidated on any role mutation. */
  userPermissions: (userId: string) => `perms:${userId}`,

  /** Rate-limit counter. */
  rateLimit: (scope: string, identifier: string) => `rl:${scope}:${identifier}`,

  /** Permission cache TTL is short so a missed invalidation self-heals. */
  permissionTtlSeconds: 300,
} as const;

export async function pingRedis(): Promise<{ ok: true; latencyMs: number }> {
  const started = process.hrtime.bigint();
  await redis.ping();
  const latencyMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  return { ok: true, latencyMs: Math.round(latencyMs * 100) / 100 };
}

/**
 * Invalidate every cached permission set derived from a role or grant change.
 *
 * Called whenever a role is granted, revoked, or has its permissions edited.
 * Because the cache is keyed per user and we cannot enumerate which users a
 * permission change affects without a query, the version-key trick is used
 * instead: see `permissionCacheVersion`.
 */
export async function bumpPermissionCacheVersion(): Promise<void> {
  await redis.incr('perms:version');
}

export async function permissionCacheVersion(): Promise<string> {
  return (await redis.get('perms:version')) ?? '0';
}

export async function closeRedis(): Promise<void> {
  // `disconnect()` rather than `quit()` for the blocking client: a consumer
  // parked in BRPOP will not answer a QUIT until its timeout expires, so the
  // graceful path would stall shutdown for as long as the pop timeout.
  redisBlocking.disconnect();
  await redis.quit().catch(() => redis.disconnect());
}
