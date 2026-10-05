import { sql } from 'drizzle-orm';

import { db } from '../../db/client.js';
import { redis } from '../../db/redis.js';
import { settings } from '../../db/schema/index.js';

/**
 * Runtime settings.
 *
 * Values live in `settings.value` as jsonb, which will hold anything. That
 * flexibility is why every read goes through a typed accessor here: a jsonb
 * column accepts `"true"` (a string) exactly as happily as `true` (a boolean),
 * and without a coercion point the mistake surfaces as an inexplicable branch
 * somewhere far away rather than as a config error where it was made.
 *
 * Cached in Redis with a short TTL. These are read on hot paths — every upload
 * checks `upload_enabled` — and a database round trip per request for a value
 * that changes monthly is waste. The TTL is short enough that a change made
 * during an incident takes effect within seconds without a cache purge.
 */

const CACHE_PREFIX = 'settings:';
const CACHE_TTL_SECONDS = 30;

/** Everything, as a flat map. Used by the admin settings screen. */
export interface SettingEntry {
  key: string;
  value: unknown;
  category: string;
  description: string | null;
  updatedAt: string;
}

async function loadAll(): Promise<Map<string, unknown>> {
  const cached = await redis.get(`${CACHE_PREFIX}all`).catch(() => null);

  if (cached) {
    try {
      return new Map(Object.entries(JSON.parse(cached) as Record<string, unknown>));
    } catch {
      // Corrupt cache entry; fall through and reload.
    }
  }

  const rows = await db.select({ key: settings.key, value: settings.value }).from(settings);
  const map = new Map(rows.map((r) => [r.key, r.value]));

  // Best effort — a cache write failure must not fail the read.
  await redis
    .set(`${CACHE_PREFIX}all`, JSON.stringify(Object.fromEntries(map)), 'EX', CACHE_TTL_SECONDS)
    .catch(() => undefined);

  return map;
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const map = await loadAll();
  const raw = map.get(key);
  return raw === undefined ? fallback : (raw as T);
}

/**
 * Boolean accessor with an explicit coercion rule.
 *
 * The string `"false"` is truthy in JavaScript. Since a value can arrive from a
 * hand-edited database row or a form that posted strings, `Boolean(raw)` would
 * silently turn "off" into "on" for exactly the settings that matter most —
 * maintenance mode, read-only mode. Anything not recognisable as true is false,
 * which fails safe for every flag currently defined.
 */
export async function getBooleanSetting(key: string, fallback: boolean): Promise<boolean> {
  const raw = await getSetting<unknown>(key, fallback);
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') return ['true', '1', 'yes', 'on'].includes(raw.toLowerCase());
  if (typeof raw === 'number') return raw !== 0;
  return fallback;
}

export async function getNumberSetting(key: string, fallback: number): Promise<number> {
  const raw = await getSetting<unknown>(key, fallback);
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export async function listSettings(): Promise<SettingEntry[]> {
  const rows = await db
    .select({
      key: settings.key,
      value: settings.value,
      category: settings.category,
      description: settings.description,
      updatedAt: settings.updatedAt,
    })
    .from(settings)
    .orderBy(settings.category, settings.key);

  return rows.map((r) => ({
    ...r,
    updatedAt: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : String(r.updatedAt),
  }));
}

/**
 * Write one setting and drop the cache.
 *
 * The cache is deleted rather than updated: two administrators saving at once
 * would otherwise race to write their own view of the whole map, and the loser
 * would silently overwrite the winner. Deleting forces the next read to come
 * from the database, which is the source of truth.
 */
export async function setSetting(
  key: string,
  value: unknown,
  actorUserId: string,
): Promise<void> {
  const updated = await db
    .update(settings)
    .set({ value: sql`${JSON.stringify(value)}::jsonb`, updatedByUserId: actorUserId, updatedAt: new Date() })
    .where(sql`${settings.key} = ${key}`)
    .returning({ key: settings.key });

  if (updated.length === 0) {
    // Insert rather than silently doing nothing — an administrator saving a
    // setting that does not exist yet (a new one added in a later release)
    // should get the value stored, not a no-op that looks like success.
    await db.insert(settings).values({
      key,
      value,
      updatedByUserId: actorUserId,
      category: 'general',
    });
  }

  await redis.del(`${CACHE_PREFIX}all`).catch(() => undefined);
}

/** Invalidate the cache. Exposed for tests and manual recovery. */
export async function invalidateSettingsCache(): Promise<void> {
  await redis.del(`${CACHE_PREFIX}all`).catch(() => undefined);
}

// --- Typed accessors for the flags the application actually branches on ------
//
// Named functions rather than string literals at each call site: a typo in a
// settings key is otherwise silent — `getBooleanSetting('maintenence_mode')`
// returns the fallback and the feature simply never activates.

export const isMaintenanceMode = () => getBooleanSetting('maintenance_mode', false);
export const isReadOnlyMode = () => getBooleanSetting('read_only_mode', false);
export const isRegistrationEnabled = () => getBooleanSetting('registration_enabled', true);
export const isUploadEnabled = () => getBooleanSetting('upload_enabled', true);
export const uploadsRequireReview = () => getBooleanSetting('uploads_require_review', false);
export const areCommentsEnabled = () => getBooleanSetting('comments_enabled', true);
export const arePostsEnabled = () => getBooleanSetting('posts_enabled', true);
export const maxUploadBytes = () => getNumberSetting('max_upload_bytes', 2_147_483_648);
