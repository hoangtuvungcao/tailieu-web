import { sql } from 'drizzle-orm';

import { db } from '../db/client.js';
import { redis } from '../db/redis.js';

/**
 * Integration test helpers.
 *
 * These tests run against a real Postgres and Redis. Two guardrails make that
 * safe:
 *
 *   1. `assertTestDatabase()` refuses to run unless the database name contains
 *      "tailieu_test". The suite revokes sessions, bumps token versions and
 *      deletes accounts — pointing it at production would be an outage, and
 *      trusting that nobody will is not a control.
 *   2. Anything created is deleted afterwards, matched by a unique email
 *      prefix, so a failed run does not poison the next one.
 */

const TEST_DB_MARKER = 'tailieu_test';

export function assertTestDatabase(): void {
  const url = process.env.DATABASE_URL ?? '';
  if (!url.includes(TEST_DB_MARKER)) {
    throw new Error(
      `Refusing to run integration tests against "${url}".\n` +
        `DATABASE_URL must point at a database whose name contains "${TEST_DB_MARKER}".\n` +
        'Create one with: createdb -U tailieu tailieu_test',
    );
  }
}

/** A unique email per test run so parallel or repeated runs never collide. */
export function uniqueEmail(label: string): string {
  return `test-${label}-${Date.now()}-${Math.floor(Math.random() * 100000)}@tailieu.test`;
}

export async function purgeUser(email: string): Promise<void> {
  await db.execute(sql`DELETE FROM users WHERE email = ${email}`);
}

/** Remove every account this suite created. Called from afterAll. */
export async function purgeTestUsers(): Promise<void> {
  await db.execute(sql`DELETE FROM users WHERE email LIKE '%@tailieu.test'`);
}

/**
 * Drop cached session liveness.
 *
 * The session-liveness cache has a 60s TTL and is written by the code under
 * test. A stale entry from a previous test would make the next one observe a
 * revoked session it never revoked — a failure that looks like a logic bug.
 */
export async function flushSessionCache(): Promise<void> {
  const keys = await redis.keys('sess:live:*');
  if (keys.length > 0) await redis.del(...keys);
}

/** Reset permission-cache versioning between tests. */
export async function flushPermissionCache(): Promise<void> {
  const keys = await redis.keys('perms:*');
  if (keys.length > 0) await redis.del(...keys);
}

export const SEEDED_STUDENT = {
  email: 'student@tailieu.local',
  password: process.env.SEED_STUDENT_PASSWORD ?? 'ChangeMe_Student_2026',
};
