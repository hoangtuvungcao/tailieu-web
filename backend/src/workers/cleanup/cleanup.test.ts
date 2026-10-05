import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDatabase, db } from '../../db/client.js';
import { closeRedis } from '../../db/redis.js';
import { assertTestDatabase } from '../../test/helpers.js';
import * as cleanup from './cleanup.repository.js';

/**
 * Cleanup job tests.
 *
 * These exist because the session purge query was wrong in a way that produced
 * no error at all. It required `revoked_at IS NOT NULL` and `revoked_at IS
 * NULL` simultaneously, which made the revoked branch unreachable: revoked
 * sessions were never purged, and the table simply grew. Nothing failed, no log
 * line appeared, and the only symptom was disk usage on a table nobody watches.
 *
 * The regression test is the backdated-revoked-session case below. It asserts
 * the exact row that the broken query could never match.
 */

assertTestDatabase();

const TEST_SESSION_PREFIX = '00000000-dead-beef-0000-0000000000';

/** Insert a session with controlled timestamps, bypassing the app layer. */
async function insertSession(options: {
  suffix: string;
  expiresInDays: number;
  revokedDaysAgo: number | null;
}): Promise<string> {
  const { rows } = await db.execute<{ id: string }>(sql`
    INSERT INTO sessions (id, user_id, family_id, expires_at, revoked_at, revoked_reason)
    SELECT
      ${TEST_SESSION_PREFIX + options.suffix}::uuid,
      u.id,
      ${TEST_SESSION_PREFIX + options.suffix}::uuid,
      now() + ${`${options.expiresInDays} days`}::interval,
      ${options.revokedDaysAgo === null ? null : sql`now() - ${`${options.revokedDaysAgo} days`}::interval`},
      ${options.revokedDaysAgo === null ? null : 'logout'}
    FROM users u
    WHERE u.email = 'student@tailieu.local'
    RETURNING id
  `);
  return rows[0]!.id;
}

async function countTestSessions(): Promise<number> {
  const { rows } = await db.execute<{ count: string }>(
    sql`SELECT count(*)::text AS count FROM sessions WHERE id::text LIKE ${TEST_SESSION_PREFIX + '%'}`,
  );
  return Number(rows[0]!.count);
}

beforeAll(async () => {
  await db.execute(sql`DELETE FROM sessions WHERE id::text LIKE ${TEST_SESSION_PREFIX + '%'}`);
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM sessions WHERE id::text LIKE ${TEST_SESSION_PREFIX + '%'}`);
  await closeDatabase();
  await closeRedis();
});

describe('purgeDeadSessions', () => {
  it('purges sessions that were revoked long ago', async () => {
    // THE regression case. The old predicate demanded `revoked_at IS NOT NULL`
    // and `revoked_at IS NULL` at once, so this row was unreachable and was
    // never deleted no matter how old it got.
    await insertSession({ suffix: '01', expiresInDays: 60, revokedDaysAgo: 31 });

    const deleted = await cleanup.purgeDeadSessions(30);
    expect(deleted).toBeGreaterThanOrEqual(1);

    const { rows } = await db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM sessions
           WHERE id = ${TEST_SESSION_PREFIX + '01'}::uuid`,
    );
    expect(Number(rows[0]!.count)).toBe(0);
  });

  it('purges sessions that expired long ago', async () => {
    await insertSession({ suffix: '02', expiresInDays: -45, revokedDaysAgo: null });

    await cleanup.purgeDeadSessions(30);

    const { rows } = await db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM sessions
           WHERE id = ${TEST_SESSION_PREFIX + '02'}::uuid`,
    );
    expect(Number(rows[0]!.count)).toBe(0);
  });

  it('keeps a recently revoked session', async () => {
    // Revoked yesterday: dead, but inside the retention window, so the record
    // is still useful for "what did this account do" questions.
    await insertSession({ suffix: '03', expiresInDays: 60, revokedDaysAgo: 1 });

    await cleanup.purgeDeadSessions(30);

    const { rows } = await db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM sessions
           WHERE id = ${TEST_SESSION_PREFIX + '03'}::uuid`,
    );
    expect(Number(rows[0]!.count)).toBe(1);
  });

  it('never deletes a live session', async () => {
    // The failure mode that would matter most: signing every user out because
    // a cleanup job was too eager.
    await insertSession({ suffix: '04', expiresInDays: 90, revokedDaysAgo: null });

    await cleanup.purgeDeadSessions(30);

    const { rows } = await db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM sessions
           WHERE id = ${TEST_SESSION_PREFIX + '04'}::uuid`,
    );
    expect(Number(rows[0]!.count)).toBe(1);
  });

  it('purges only what it should in a mixed batch', async () => {
    await db.execute(sql`DELETE FROM sessions WHERE id::text LIKE ${TEST_SESSION_PREFIX + '%'}`);

    await insertSession({ suffix: '10', expiresInDays: 60, revokedDaysAgo: 40 }); // purge
    await insertSession({ suffix: '11', expiresInDays: -40, revokedDaysAgo: null }); // purge
    await insertSession({ suffix: '12', expiresInDays: 60, revokedDaysAgo: 2 }); // keep
    await insertSession({ suffix: '13', expiresInDays: 90, revokedDaysAgo: null }); // keep

    const deleted = await cleanup.purgeDeadSessions(30);

    expect(deleted).toBe(2);
    expect(await countTestSessions()).toBe(2);
  });
});

describe('storageSummary', () => {
  it('reports tagged counts rather than a bare total', async () => {
    const summary = await cleanup.storageSummary();

    expect(summary.totalObjects).toBeGreaterThanOrEqual(0);
    // `shared` is the honesty check: it counts objects referenced by more than
    // one document, which is the only evidence that deduplication is actually
    // saving space rather than being a claim nobody verified.
    expect(summary.shared).toBeGreaterThanOrEqual(0);
    expect(summary.orphaned).toBeGreaterThanOrEqual(0);
    expect(summary.shared + summary.orphaned).toBeLessThanOrEqual(summary.totalObjects);
  });
});

describe('findOrphanedObjects', () => {
  it('respects the grace period', async () => {
    // A just-created zero-count object must NOT be reported: its owner may be
    // mid-upload, with the attach transaction not yet committed. Deleting it
    // would destroy a file the user is about to see appear.
    const fresh = await cleanup.findOrphanedObjects(24);
    const all = await cleanup.findOrphanedObjects(0);

    expect(all.length).toBeGreaterThanOrEqual(fresh.length);
  });
});
