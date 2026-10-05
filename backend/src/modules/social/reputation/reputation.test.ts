import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../../app.js';
import { closeDatabase, db } from '../../../db/client.js';
import { closeRedis } from '../../../db/redis.js';
import { hashPassword } from '../../../lib/password.js';
import { assertTestDatabase, flushPermissionCache, flushSessionCache } from '../../../test/helpers.js';
import { award } from './reputation.service.js';

/**
 * Reputation and badges.
 *
 * A points system is a spam system unless every rule is chosen against it, so
 * the assertions here are mostly about what does NOT pay: liking your own post,
 * liking the same post twice, and liking faster than the caps allow. Those are
 * the three loops a farmer reaches for first.
 *
 * Both accounts are created by this suite rather than reusing the seeded
 * student. That keeps the cleanup exact — deleting an account cascades its
 * reputation events and its leaderboard rows — and it means an absolute
 * assertion about a total is about this test and not about every previous run.
 */

assertTestDatabase();

let app: FastifyInstance;
let authorToken: string;
let authorId: string;
let likerToken: string;
let likerId: string;
let secondGiverId: string;

const AUTHOR_EMAIL = 'rep-author@tailieu.test';
const LIKER_EMAIL = 'rep-liker@tailieu.test';
const SECOND_EMAIL = 'rep-second@tailieu.test';
const MARKER = 'REP-';
const TEST_BADGE = 'rep-test-badge';

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
  const passwordHash = await hashPassword('Rep_2026!');
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

async function createPost(body: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/posts',
    headers: auth(authorToken),
    payload: { body: `${MARKER}${body}`, visibility: 'public', postKind: 'status', tags: [] },
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { data: { id: string } }).data.id;
}

function like(postId: string, liked: boolean, token = likerToken) {
  return app.inject({
    method: 'PUT',
    url: `/api/v1/likes/post/${postId}`,
    headers: auth(token),
    payload: { liked },
  });
}

async function reputationOf(userId: string): Promise<number> {
  const result = await db.execute<{ total: number }>(
    sql`SELECT coalesce(sum(delta), 0)::int AS total FROM reputation_events WHERE user_id = ${userId}::uuid`,
  );
  return Number(result.rows[0]?.total ?? 0);
}

async function profileOf(userId: string) {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/users/${userId}`,
    headers: auth(likerToken),
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as {
    data: { reputation: number; badges: { code: string; name: string }[] };
  }).data;
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  await db.execute(
    sql`DELETE FROM users WHERE email IN (${AUTHOR_EMAIL}, ${LIKER_EMAIL}, ${SECOND_EMAIL})`,
  );
  authorId = await createUser(AUTHOR_EMAIL, 'Tác giả kiểm thử');
  likerId = await createUser(LIKER_EMAIL, 'Người thích kiểm thử');
  // No token: this account is only ever an actor in a direct service call.
  secondGiverId = await createUser(SECOND_EMAIL, 'Người thích thứ hai');

  authorToken = await login(AUTHOR_EMAIL, 'Rep_2026!');
  likerToken = await login(LIKER_EMAIL, 'Rep_2026!');

  // A badge that fires after a single like, so the lazy threshold check can be
  // observed without generating 50 points of traffic first.
  await db.execute(sql`DELETE FROM badges WHERE code = ${TEST_BADGE}`);
  await db.execute(sql`
    INSERT INTO badges (code, name, description, tier, category, criteria, is_active)
    VALUES (
      ${TEST_BADGE}, 'Huy hiệu kiểm thử', 'Dùng cho kiểm thử tự động.', 1, 'test',
      '{"metric":"reputation","threshold":2}'::jsonb, true
    )
  `);
});

afterAll(async () => {
  // Notifications and posts first: both are polymorphic and nothing cascades
  // from an account deletion to a row that merely points at it.
  await db.execute(sql`
    DELETE FROM notifications
     WHERE actor_user_id IN (${authorId}::uuid, ${likerId}::uuid)
        OR recipient_user_id IN (${authorId}::uuid, ${likerId}::uuid)
  `);
  // Events where a test account was the *actor* but the recipient was somebody
  // else survive that account's deletion (`onDelete: set null`), so they are
  // removed by actor rather than left behind attributing points to nobody.
  await db.execute(sql`
    DELETE FROM reputation_events
     WHERE actor_user_id IN (${authorId}::uuid, ${likerId}::uuid, ${secondGiverId}::uuid)
  `);
  await db.execute(sql`DELETE FROM posts WHERE author_user_id IN (${authorId}::uuid, ${likerId}::uuid)`);
  // Cascades reputation_events, user_badges and leaderboard_running_totals.
  await db.execute(
    sql`DELETE FROM users WHERE email IN (${AUTHOR_EMAIL}, ${LIKER_EMAIL}, ${SECOND_EMAIL})`,
  );
  await db.execute(sql`DELETE FROM badges WHERE code = ${TEST_BADGE}`);

  await app.close();
  await closeDatabase();
  await closeRedis();
});

beforeEach(async () => {
  await flushSessionCache();
  await flushPermissionCache();
  // Every test starts from a clean score for both accounts.
  await db.execute(sql`
    DELETE FROM reputation_events
     WHERE user_id IN (${authorId}::uuid, ${likerId}::uuid)
        OR actor_user_id IN (${authorId}::uuid, ${likerId}::uuid, ${secondGiverId}::uuid)
  `);
  await db.execute(sql`
    DELETE FROM leaderboard_running_totals
     WHERE user_id IN (${authorId}::uuid, ${likerId}::uuid, ${secondGiverId}::uuid)
  `);
  await db.execute(sql`
    DELETE FROM user_badges
     WHERE user_id IN (${authorId}::uuid, ${likerId}::uuid, ${secondGiverId}::uuid)
  `);
});

describe('earning reputation', () => {
  it('credits the author when somebody else likes their post', async () => {
    const postId = await createPost('bài được thích');
    const response = await like(postId, true);
    expect(response.statusCode).toBe(200);

    // 2 points for a like received, from BASE_POINTS.
    expect(await reputationOf(authorId)).toBe(2);
  });

  it('pays nothing when you like your own post', async () => {
    const postId = await createPost('bài tự thích');
    // The author likes their own post — the oldest trick there is.
    const response = await like(postId, true, authorToken);
    expect(response.statusCode).toBe(200);

    expect(await reputationOf(authorId)).toBe(0);
  });

  it('pays once for a like, however many times it is toggled', async () => {
    const postId = await createPost('bài bị bật tắt');

    await like(postId, true);
    await like(postId, false);
    await like(postId, true);
    await like(postId, false);
    await like(postId, true);

    // The dedupe key pins the award to (target, id), so the unlike/re-like loop
    // — the cheapest farming loop there is — pays exactly once.
    expect(await reputationOf(authorId)).toBe(2);
  });

  it('counts a second, different like separately', async () => {
    const first = await createPost('bài thứ nhất');
    const second = await createPost('bài thứ hai');

    await like(first, true);
    await like(second, true);

    expect(await reputationOf(authorId)).toBe(4);
  });

  it('appears on the profile', async () => {
    const postId = await createPost('bài để xem hồ sơ');
    await like(postId, true);

    expect((await profileOf(authorId)).reputation).toBe(2);
  });
});

describe('the caps', () => {
  /**
   * Exercised through the service rather than the API, because reaching the
   * daily ceiling through likes would take fifty requests and would be testing
   * the cap by accident rather than on purpose.
   */
  it('clamps one giver at the per-relationship ceiling', async () => {
    const grant = (points: number) =>
      db.transaction((tx) =>
        award(tx, {
          userId: authorId,
          actorUserId: likerId,
          reason: 'like_received',
          points,
        }),
      );

    // The per-actor ceiling is 20 in a rolling 24 hours.
    expect(await grant(15)).toBe(15);
    // Only 5 of the next 15 fit under the ceiling, and the partial credit is
    // reported rather than the request being silently dropped.
    expect(await grant(15)).toBe(5);
    // Nothing left.
    expect(await grant(15)).toBe(0);

    expect(await reputationOf(authorId)).toBe(20);
  });

  it('gives a second giver their own headroom', async () => {
    await db.transaction((tx) =>
      award(tx, { userId: authorId, actorUserId: likerId, reason: 'like_received', points: 20 }),
    );

    // The ceiling is per (giver, recipient), not a single global one on the
    // recipient. A global cap would freeze the score of anyone who happened to
    // be liked a lot early in the day, which punishes being popular.
    const fromSecond = await db.transaction((tx) =>
      award(tx, {
        userId: authorId,
        actorUserId: secondGiverId,
        reason: 'like_received',
        points: 10,
      }),
    );

    expect(fromSecond).toBe(10);
    expect(await reputationOf(authorId)).toBe(30);
  });

  it('does not cap a penalty away', async () => {
    await db.transaction((tx) =>
      award(tx, { userId: authorId, actorUserId: likerId, reason: 'like_received', points: 20 }),
    );

    // Punishment is not subject to the praise ceiling — otherwise the cheapest
    // strategy would be to farm to the cap and then misbehave for free.
    const debited = await db.transaction((tx) =>
      award(tx, {
        userId: authorId,
        actorUserId: null,
        reason: 'moderation_penalty',
        points: -30,
      }),
    );

    expect(debited).toBe(-30);
    expect(await reputationOf(authorId)).toBe(-10);
  });
});

describe('badges', () => {
  it('are awarded lazily when the threshold is crossed', async () => {
    const postId = await createPost('bài để nhận huy hiệu');
    await like(postId, true);

    const profile = await profileOf(authorId);
    expect(profile.badges.map((badge) => badge.code)).toContain(TEST_BADGE);
  });

  it('are not awarded twice', async () => {
    const first = await createPost('bài thứ nhất');
    const second = await createPost('bài thứ hai');
    await like(first, true);
    await like(second, true);

    const held = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM user_badges
       WHERE user_id = ${authorId}::uuid AND badge_id = (SELECT id FROM badges WHERE code = ${TEST_BADGE})
    `);
    expect(Number(held.rows[0]?.n ?? 0)).toBe(1);
  });

  it('are not awarded while the threshold is unmet', async () => {
    // No likes at all, so no reputation event and therefore no evaluation.
    await createPost('bài chưa được thích');
    expect((await profileOf(authorId)).badges).toHaveLength(0);
  });
});

describe('the leaderboard running totals', () => {
  /**
   * The subtle failure this guards. The university row has `scope_id IS NULL`,
   * and without `NULLS NOT DISTINCT` the ON CONFLICT would not recognise its
   * own row — so every event would insert another instead of accumulating, and
   * the leaderboard would quietly count each event as a separate member.
   */
  it('accumulate into one row rather than inserting one per event', async () => {
    const first = await createPost('bài thứ nhất');
    const second = await createPost('bài thứ hai');
    await like(first, true);
    await like(second, true);

    const rows = await db.execute<{ score: string; n: number }>(sql`
      SELECT score, count(*) OVER ()::int AS n
        FROM leaderboard_running_totals
       WHERE user_id = ${authorId}::uuid AND scope_type = 'university' AND scope_id IS NULL
    `);

    expect(Number(rows.rows[0]?.n ?? 0)).toBe(1);
    expect(Number(rows.rows[0]?.score ?? 0)).toBe(4);
  });
});
