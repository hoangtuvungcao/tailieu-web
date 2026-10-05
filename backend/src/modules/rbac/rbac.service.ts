import { redis, permissionCacheVersion } from '../../db/redis.js';
import {
  isSessionLive,
  selectModerationScope,
  selectPermissionKeys,
  selectUserRoles,
  type ResolvedRole,
} from './rbac.repository.js';

/**
 * RBAC resolution with Redis caching.
 *
 * Permissions are resolved per request rather than embedded in the JWT, so a
 * revocation takes effect immediately instead of after the access token
 * expires. That correctness costs a lookup, which this cache absorbs.
 *
 * Invalidation uses a version counter rather than key deletion. A role change
 * can affect an unknown number of users, so deleting their keys would require
 * enumerating them. Instead every cache key embeds the current version; bumping
 * the version makes every existing key unreachable at once, and the old keys
 * age out on their own TTL. One INCR invalidates the world.
 *
 * Every function here degrades to a direct database read if Redis is
 * unavailable. Permission checks must never fail open OR closed because the
 * cache is down — they must simply be slower.
 */

async function cacheKey(prefix: string, userId: string): Promise<string> {
  const version = await permissionCacheVersion().catch(() => '0');
  return `${prefix}:v${version}:${userId}`;
}

/** Effective permissions, cached. Returns a Set for O(1) membership tests. */
export async function getUserPermissions(userId: string): Promise<Set<string>> {
  const key = await cacheKey('perms', userId).catch(() => null);

  if (key) {
    try {
      const cached = await redis.get(key);
      if (cached) return new Set(JSON.parse(cached) as string[]);
    } catch {
      // Fall through to the database.
    }
  }

  const keys = await selectPermissionKeys(userId);
  const set = new Set(keys);

  if (key) {
    try {
      // TTL bounds staleness even if an invalidation is ever missed.
      await redis.set(key, JSON.stringify(keys), 'EX', 300);
    } catch {
      // Cache write failure is not a request failure.
    }
  }

  return set;
}

/** Role keys for a user, cached alongside permissions. */
export async function getUserRoles(userId: string): Promise<ResolvedRole[]> {
  const key = await cacheKey('roles', userId).catch(() => null);

  if (key) {
    try {
      const cached = await redis.get(key);
      if (cached) return JSON.parse(cached) as ResolvedRole[];
    } catch {
      // Fall through.
    }
  }

  const roles = await selectUserRoles(userId);

  if (key) {
    try {
      await redis.set(key, JSON.stringify(roles), 'EX', 300);
    } catch {
      // Ignore.
    }
  }

  return roles;
}

export async function getUserModerationScope(
  userId: string,
): Promise<{ global: boolean; facultyIds: string[] }> {
  const key = await cacheKey('scope', userId).catch(() => null);

  if (key) {
    try {
      const cached = await redis.get(key);
      if (cached) return JSON.parse(cached) as { global: boolean; facultyIds: string[] };
    } catch {
      // Fall through.
    }
  }

  const scope = await selectModerationScope(userId);

  if (key) {
    try {
      await redis.set(key, JSON.stringify(scope), 'EX', 300);
    } catch {
      // Ignore.
    }
  }

  return scope;
}

/**
 * Session liveness, cached briefly.
 *
 * Without a cache this is a database round-trip on every authenticated
 * request, which is the single hottest query in the system. The TTL is short
 * (60s) and logout deletes the key explicitly, so revocation is immediate in
 * the common case and at worst a minute late in the pathological one — a good
 * trade against a query per request.
 */
export async function isSessionActive(sessionId: string, userId: string): Promise<boolean> {
  const key = `sess:live:${sessionId}`;

  try {
    const cached = await redis.get(key);
    if (cached === '1') return true;
    // A present-but-not-'1' value means explicitly revoked; do not fall through
    // to a database read that would resurrect it.
    if (cached === '0') return false;
  } catch {
    // Redis down: fall through to the authoritative check.
  }

  const live = await isSessionLive(sessionId, userId);

  try {
    await redis.set(key, live ? '1' : '0', 'EX', 60);
  } catch {
    // Ignore.
  }

  return live;
}

/** Mark a session dead immediately, bypassing the cache TTL. */
export async function markSessionRevoked(sessionId: string): Promise<void> {
  try {
    await redis.set(`sess:live:${sessionId}`, '0', 'EX', 300);
  } catch {
    // The database remains authoritative; the cache will expire on its own.
  }
}

/**
 * Invalidate all cached permission data after a role or grant change.
 *
 * Called inside the same transaction's aftermath — after commit — so a
 * rollback cannot leave the cache claiming a grant that does not exist.
 */
export async function invalidatePermissionCaches(): Promise<void> {
  try {
    await redis.incr('perms:version');
  } catch {
    // If this fails, the 300s TTL still bounds staleness.
  }
}
