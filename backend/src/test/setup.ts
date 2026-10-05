import { sql } from 'drizzle-orm';

import { db, closeDatabase } from '../db/client.js';
import { closeRedis } from '../db/redis.js';
import { redis } from '../db/redis.js';

/**
 * Test harness setup.
 *
 * Refuses to run against anything that does not look like a disposable
 * database. The tests revoke sessions, bump token versions and delete users —
 * running them against production would be a outage, and "it was in the
 * .env" is not a good enough safeguard.
 */

const TEST_DB_MARKER = 'tailieu_test';

export function assertTestDatabase(): void {
  const url = process.env.DATABASE_URL ?? '';
  if (process.env.NODE_ENV === 'test' && !url.includes(TEST_DB_MARKER)) {
    throw new Error(
      `Refusing to run tests against "${url}".\n` +
        `Set DATABASE_URL to a database whose name contains "${TEST_DB_MARKER}".`,
    );
  }
}

/** Remove an account and everything cascading from it. */
export async function purgeUser(email: string): Promise<void> {
  await db.execute(sql`DELETE FROM users WHERE email = ${email}`);
}

/** Remove every account created by a test run, matched by email suffix. */
export async function purgeUsersLike(pattern: string): Promise<void> {
  await db.execute(sql`DELETE FROM users WHERE email LIKE ${pattern}`);
}

export async function flushSessionCache(): Promise<void> {
  const keys = await redis.keys('sess:live:*');
  if (keys.length > 0) await redis.del(...keys);
}

export async function teardown(): Promise<void> {
  await closeDatabase();
  await closeRedis();
}
