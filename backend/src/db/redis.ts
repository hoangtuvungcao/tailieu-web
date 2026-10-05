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
  await redis.quit().catch(() => redis.disconnect());
}
