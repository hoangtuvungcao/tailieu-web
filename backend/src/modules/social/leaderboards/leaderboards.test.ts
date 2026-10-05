import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../../app.js';
import { closeDatabase, db } from '../../../db/client.js';
import { closeRedis } from '../../../db/redis.js';
import { hashPassword } from '../../../lib/password.js';
import { assertTestDatabase, flushPermissionCache, flushSessionCache } from '../../../test/helpers.js';
import { currentMonthKey } from '../shared/periods.js';
import { award } from '../reputation/reputation.service.js';

/**
 * Leaderboards.
 *
 * The board is a read over `leaderboard_running_totals`, so what is worth
 * testing is not the arithmetic — the reputation suite already pins that — but
 * the ways a read goes wrong quietly:
 *
 *   - The university board lives in rows with `scope_id IS NULL`. A `= NULL`
 *     comparison matches nothing, and the result is a permanently empty board
 *     with no error anywhere.
 *   - The writer and the reader both build a period key from a date. Two copies
 *     of that format means a board that returns nobody for a correct-looking
 *     request.
 *   - Rank is "how many are ahead, plus one". Computing it differently in the
 *     list and in the viewer's own standing means the same person sees two
 *     different ranks on one screen.
 */

assertTestDatabase();

let app: FastifyInstance;
let topId: string;
let secondId: string;
let giverId: string;
let absentId: string;
let topToken: string;

const EMAILS = {
  top: 'lb-top@tailieu.test',
  second: 'lb-second@tailieu.test',
  giver: 'lb-giver@tailieu.test',
  absent: 'lb-absent@tailieu.test',
};

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function login(email: string, password: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password },
  });
  const body = response.json() as { data?: { accessToken: string } };
  if (!body.data) throw new Error(`login failed for ${email}`);
  return body.data.accessToken;
}

async function createUser(email: string, displayName: string): Promise<string> {
  const passwordHash = await hashPassword('Lb_2026!');
  await db.execute(sql`
    INSERT INTO users (email, display_name, email_verified_at, status)
    VALUES (${email}, ${displayName}, now(), 'active')
  `);
  const created = await db.execute<{ id: string }>(
    sql`SELECT id FROM users WHERE email = ${email}`,
  );
  const id = created.rows[0]!.id;
  await db.execute(sql`
    INSERT INTO auth_identities (user_id, provider, provider_uid, password_hash)
    VALUES (${id}::uuid, 'password', ${email}, ${passwordHash})
  `);
  await db.execute(sql`
    INSERT INTO user_roles (user_id, role_id)
    SELECT ${id}::uuid, r.id FROM roles r WHERE r.key = 'student'
  `);
  return id;
}

/** Credit through the real service, so the board is fed the way production feeds it. */
function grant(userId: string, points: number, actorUserId = giverId) {
  return db.transaction((tx) =>
    award(tx, { userId, actorUserId, reason: 'like_received', points }),
  );
}

async function board(query = '', token?: string) {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/leaderboards${query}`,
    headers: token ? auth(token) : {},
  });
  return response;
}

interface BoardShape {
  periodKey: string;
  scope: string;
  entries: { rank: number; userId: string; displayName: string; score: number; isViewer: boolean }[];
  viewer: { rank: number; score: number } | null;
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  const emails = Object.values(EMAILS);
  await db.execute(sql`DELETE FROM users WHERE email = ANY(${sql.raw(`ARRAY['${emails.join("','")}']`)})`);

  topId = await createUser(EMAILS.top, 'Người đứng đầu');
  secondId = await createUser(EMAILS.second, 'Người thứ hai');
  giverId = await createUser(EMAILS.giver, 'Người tặng điểm');
  absentId = await createUser(EMAILS.absent, 'Người không có điểm');

  topToken = await login(EMAILS.top, 'Lb_2026!');
});

afterAll(async () => {
  await db.execute(sql`
    DELETE FROM reputation_events
     WHERE user_id IN (${topId}::uuid, ${secondId}::uuid, ${giverId}::uuid, ${absentId}::uuid)
  `);
  await db.execute(sql`
    DELETE FROM leaderboard_running_totals
     WHERE user_id IN (${topId}::uuid, ${secondId}::uuid, ${giverId}::uuid, ${absentId}::uuid)
  `);
  await db.execute(sql`
    DELETE FROM user_badges
     WHERE user_id IN (${topId}::uuid, ${secondId}::uuid, ${giverId}::uuid, ${absentId}::uuid)
  `);
  await db.execute(sql`
    DELETE FROM notifications
     WHERE actor_user_id IN (${topId}::uuid, ${secondId}::uuid, ${giverId}::uuid, ${absentId}::uuid)
        OR recipient_user_id IN (${topId}::uuid, ${secondId}::uuid, ${giverId}::uuid, ${absentId}::uuid)
  `);
  await db.execute(sql`
    DELETE FROM users WHERE id IN (${topId}::uuid, ${secondId}::uuid, ${giverId}::uuid, ${absentId}::uuid)
  `);

  await app.close();
  await closeDatabase();
  await closeRedis();
});

beforeEach(async () => {
  await flushSessionCache();
  await flushPermissionCache();
  await db.execute(sql`
    DELETE FROM reputation_events
     WHERE user_id IN (${topId}::uuid, ${secondId}::uuid, ${giverId}::uuid, ${absentId}::uuid)
  `);
  await db.execute(sql`
    DELETE FROM leaderboard_running_totals
     WHERE user_id IN (${topId}::uuid, ${secondId}::uuid, ${giverId}::uuid, ${absentId}::uuid)
  `);

  // 15 and 10, both under the per-giver ceiling of 20.
  await grant(topId, 15);
  await grant(secondId, 10);
});

describe('the university board', () => {
  it('ranks by score, highest first', async () => {
    const response = await board();
    expect(response.statusCode).toBe(200);

    const data = (response.json() as { data: BoardShape }).data;
    expect(data.entries.map((entry) => entry.userId)).toEqual([topId, secondId]);
    expect(data.entries.map((entry) => entry.rank)).toEqual([1, 2]);
    expect(data.entries.map((entry) => entry.score)).toEqual([15, 10]);
  });

  it('omits accounts with no positive score', async () => {
    const data = (await board()).json() as { data: BoardShape };
    const ids = data.data.entries.map((entry) => entry.userId);

    // `absent` has no row at all; the giver has one only if they were credited,
    // which they never were. Neither belongs on a "top contributors" list.
    expect(ids).not.toContain(absentId);
    expect(ids).not.toContain(giverId);
  });

  it('uses the same period key the writer stored', async () => {
    const data = (await board()).json() as { data: BoardShape };
    // If the reader and the writer disagreed about the format, the board would
    // be empty and this assertion would still pass — so the entries above are
    // what actually proves it. This pins the value the key must have.
    expect(data.data.periodKey).toBe(currentMonthKey());
    expect(data.data.periodKey).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/);
  });

  it('is readable while signed out', async () => {
    expect((await board()).statusCode).toBe(200);
  });
});

describe('the viewer’s own standing', () => {
  it('appears on their own row', async () => {
    const data = (await board('', topToken)).json() as { data: BoardShape };
    expect(data.data.entries[0]!.isViewer).toBe(true);
    expect(data.data.viewer).toEqual({ rank: 1, score: 15 });
  });

  it('is reported even when they are off the returned page', async () => {
    // One entry per page, so the second-place account is not in the list.
    const data = (await board('?limit=1', await login(EMAILS.second, 'Lb_2026!'))).json() as {
      data: BoardShape;
    };

    expect(data.data.entries).toHaveLength(1);
    expect(data.data.entries[0]!.userId).toBe(topId);
    // Rank 2, computed by the same rule the list uses — so the number here and
    // the number they would see in the list cannot disagree.
    expect(data.data.viewer).toEqual({ rank: 2, score: 10 });
  });

  it('is null for somebody who has never earned a point', async () => {
    const data = (await board('', await login(EMAILS.absent, 'Lb_2026!'))).json() as {
      data: BoardShape;
    };
    // Not "rank 0" or a shared last place — showing a rank to somebody with no
    // score would be an invitation to ask what it means.
    expect(data.data.viewer).toBeNull();
  });

  it('is null when nobody is signed in', async () => {
    expect(((await board()).json() as { data: BoardShape }).data.viewer).toBeNull();
  });
});

describe('scoping', () => {
  it('refuses a scopeId on the university board', async () => {
    // The university row is stored with a NULL scope, so an id here would query
    // a scope nothing writes and return an empty board that looks correct.
    const response = await board(`?scopeId=${topId}`);
    expect(response.statusCode).toBe(400);
  });

  it('requires a scopeId for a faculty board', async () => {
    expect((await board('?scope=faculty')).statusCode).toBe(400);
  });

  it('refuses a period that is not a month key', async () => {
    expect((await board('?period=2026')).statusCode).toBe(422);
    expect((await board('?period=2026-13')).statusCode).toBe(422);
  });

  it('returns an empty board for a month with no events', async () => {
    const response = await board('?period=2020-01');
    expect(response.statusCode).toBe(200);

    const data = (response.json() as { data: BoardShape }).data;
    expect(data.entries).toHaveLength(0);
  });
});

describe('an anonymised account', () => {
  it('is dropped from the board, and does not keep its rank', async () => {
    await db.execute(sql`UPDATE users SET anonymized_at = now() WHERE id = ${topId}::uuid`);

    const data = (await board()).json() as { data: BoardShape };
    expect(data.data.entries.map((entry) => entry.userId)).toEqual([secondId]);
    // The leader keeps their points; they simply are not shown. Promoting the
    // runner-up to rank 1 is the honest outcome — the alternative is a board
    // with a hole in it.
    expect(data.data.entries[0]!.rank).toBe(1);

    await db.execute(sql`UPDATE users SET anonymized_at = NULL WHERE id = ${topId}::uuid`);
  });
});
