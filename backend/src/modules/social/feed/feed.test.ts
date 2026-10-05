import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../../app.js';
import { closeDatabase, db } from '../../../db/client.js';
import { closeRedis, redis } from '../../../db/redis.js';
import { hashPassword } from '../../../lib/password.js';
import { assertTestDatabase, flushPermissionCache, flushSessionCache } from '../../../test/helpers.js';
import { recordTrendSignal } from './trending.js';

/**
 * The ranked feed.
 *
 * Two things are worth testing here and one of them is not the ranking.
 *
 * The ranking is a heuristic by construction, so asserting an exact order would
 * pin a formula rather than a property — the useful assertions are "the thing
 * with more signals comes first" and "the viewer's own predicate still applies".
 *
 * What IS worth pinning is the degradation. Trending reads Redis and must never
 * turn a cache miss into an error: a Redis outage has to produce a slightly
 * staler list, not a 500. And it must produce that *and say so*, because
 * "trending" is a claim the server cannot back when the fallback ran.
 */

assertTestDatabase();

let app: FastifyInstance;
let authorId: string;
let authorToken: string;
let likerId: string;
let likerToken: string;

const AUTHOR_EMAIL = 'feed-author@tailieu.test';
const LIKER_EMAIL = 'feed-liker@tailieu.test';
const MARKER = 'FEED-';

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

async function createUser(email: string, displayName: string, facultyId?: string): Promise<string> {
  const passwordHash = await hashPassword('Feed_2026!');
  await db.execute(sql`
    INSERT INTO users (email, display_name, email_verified_at, status, primary_faculty_id)
    VALUES (${email}, ${displayName}, now(), 'active', ${facultyId ?? null}::uuid)
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

async function createPost(body: string, token = authorToken): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/posts',
    headers: auth(token),
    payload: { body: `${MARKER}${body}`, visibility: 'public', postKind: 'status', tags: [] },
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { data: { id: string } }).data.id;
}

function like(postId: string, token = likerToken) {
  return app.inject({
    method: 'PUT',
    url: `/api/v1/likes/post/${postId}`,
    headers: auth(token),
    payload: { liked: true },
  });
}

async function feed(path: string, token?: string) {
  return app.inject({
    method: 'GET',
    url: `/api/v1/feed/${path}`,
    headers: token ? auth(token) : {},
  });
}

/** Drop the trend buckets so each test starts from an empty cache. */
async function clearTrend(): Promise<void> {
  const keys = await redis.keys('trend:*');
  if (keys.length > 0) await redis.del(...keys);
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  await db.execute(sql`DELETE FROM users WHERE email IN (${AUTHOR_EMAIL}, ${LIKER_EMAIL})`);
  authorId = await createUser(AUTHOR_EMAIL, 'Tác giả bảng tin');
  likerId = await createUser(LIKER_EMAIL, 'Người xem bảng tin');
  authorToken = await login(AUTHOR_EMAIL, 'Feed_2026!');
  likerToken = await login(LIKER_EMAIL, 'Feed_2026!');
});

afterAll(async () => {
  await clearTrend();
  await db.execute(sql`
    DELETE FROM reputation_events
     WHERE user_id IN (${authorId}::uuid, ${likerId}::uuid)
        OR actor_user_id IN (${authorId}::uuid, ${likerId}::uuid)
  `);
  await db.execute(sql`
    DELETE FROM leaderboard_running_totals
     WHERE user_id IN (${authorId}::uuid, ${likerId}::uuid)
  `);
  await db.execute(sql`
    DELETE FROM notifications
     WHERE actor_user_id IN (${authorId}::uuid, ${likerId}::uuid)
        OR recipient_user_id IN (${authorId}::uuid, ${likerId}::uuid)
  `);
  await db.execute(sql`
    DELETE FROM posts WHERE author_user_id IN (${authorId}::uuid, ${likerId}::uuid)
  `);
  await db.execute(sql`DELETE FROM users WHERE email IN (${AUTHOR_EMAIL}, ${LIKER_EMAIL})`);

  await app.close();
  await closeDatabase();
  await closeRedis();
});

beforeEach(async () => {
  await flushSessionCache();
  await flushPermissionCache();
  await clearTrend();
  await db.execute(sql`
    DELETE FROM posts WHERE author_user_id IN (${authorId}::uuid, ${likerId}::uuid)
  `);
});

describe('trending', () => {
  it('ranks a post with more signals above one with fewer', async () => {
    const quiet = await createPost('bài ít tương tác');
    const busy = await createPost('bài nhiều tương tác');

    await recordTrendSignal(quiet, 1);
    await recordTrendSignal(busy, 9);

    const response = await feed('trending');
    expect(response.statusCode).toBe(200);

    const body = response.json() as { data: { id: string }[]; meta: { ranking: string } };
    expect(body.meta.ranking).toBe('trending');
    expect(body.data[0]!.id).toBe(busy);
  });

  it('records a signal when somebody likes a post', async () => {
    const postId = await createPost('bài được thích');
    const response = await like(postId);
    expect(response.statusCode).toBe(200);

    const body = (await feed('trending')).json() as { data: { id: string }[] };
    expect(body.data.map((p) => p.id)).toContain(postId);
  });

  it('records a score in the bucket when somebody else likes a post', async () => {
    const postId = await createPost('bài được người khác thích');
    await like(postId);

    const hour = Math.floor(Date.now() / 3_600_000);
    expect(await redis.zscore(`trend:h:${hour}`, postId)).not.toBeNull();
  });

  it('records nothing for a self-like', async () => {
    const postId = await createPost('bài tự thích');
    const response = await like(postId, authorToken);
    expect(response.statusCode).toBe(200);

    // Asserted on the bucket, not on the rendered list. With an empty cache the
    // list falls back to SQL, which ranks on `hot_score` — and that DOES count
    // self-likes — so the post would appear either way and a list-level
    // assertion would pass without proving anything.
    //
    // The like itself is real: the counter moves and the post's score rises.
    // It is only worthless as a ranking signal, which is why the check is here
    // rather than in `setLike`.
    const hour = Math.floor(Date.now() / 3_600_000);
    expect(await redis.zscore(`trend:h:${hour}`, postId)).toBeNull();
  });

  it('falls back to SQL, and says so, when nothing is cached', async () => {
    await createPost('bài chưa ai tương tác');

    const response = await feed('trending');
    const body = response.json() as { data: { id: string }[]; meta: { ranking: string } };

    // Not an error: trending is an accelerator, and a page that fails because a
    // cache is empty is worse than a staler list.
    expect(response.statusCode).toBe(200);
    expect(body.meta.ranking).toBe('popular-fallback');
  });

  it('never shows a post the viewer may not see, even when it trends', async () => {
    const postId = await createPost('bài sẽ chuyển riêng tư');
    await recordTrendSignal(postId, 50);
    await db.execute(sql`UPDATE posts SET visibility = 'private' WHERE id = ${postId}::uuid`);

    // Signed out, so the owner's own-view rule does not apply.
    const body = (await feed('trending')).json() as { data: { id: string }[] };
    expect(body.data.map((p) => p.id)).not.toContain(postId);

    // And the ranking is still honest about which list this was.
    const asAnonymous = (await feed('trending')).json() as { meta: { ranking: string } };
    expect(asAnonymous.meta.ranking).toBe('popular-fallback');
  });

  it('is readable while signed out', async () => {
    expect((await feed('trending')).statusCode).toBe(200);
  });
});

describe('for you', () => {
  it('requires an account', async () => {
    // Every term in the heuristic needs a viewer. Serving an unpersonalised
    // list under this name would be the one thing the label must not do.
    expect((await feed('for-you')).statusCode).toBe(401);
  });

  it('ranks a followed author above an unfollowed one', async () => {
    const stranger = await createPost('bài của người lạ', authorToken);
    const followed = await createPost('bài của người được theo dõi', likerToken);

    await app.inject({
      method: 'PUT',
      url: `/api/v1/follows/${likerId}`,
      headers: auth(authorToken),
      payload: { following: true },
    });

    // For the author: `likerId` is now followed, so their post outranks the
    // stranger's even with no engagement on either.
    const body = (await feed('for-you', authorToken)).json() as {
      data: { id: string }[];
      meta: { ranking: string; note?: string };
    };

    expect(body.meta.ranking).toBe('heuristic');
    // Said in the response, not only in the UI source.
    expect(body.meta.note).toContain('heuristic');

    const ids = body.data.map((p) => p.id);
    expect(ids).toContain(followed);
    expect(ids.indexOf(followed)).toBeLessThan(ids.includes(stranger) ? ids.indexOf(stranger) : Infinity);

    await app.inject({
      method: 'PUT',
      url: `/api/v1/follows/${likerId}`,
      headers: auth(authorToken),
      payload: { following: false },
    });
  });

  it('still returns a feed when Redis has nothing to contribute', async () => {
    await createPost('bài để xem gợi ý', authorToken);
    await clearTrend();

    const response = await feed('for-you', authorToken);
    expect(response.statusCode).toBe(200);
    // The trend term contributes nothing; the other two terms still rank.
    expect((response.json() as { data: unknown[] }).data.length).toBeGreaterThan(0);
  });
});
