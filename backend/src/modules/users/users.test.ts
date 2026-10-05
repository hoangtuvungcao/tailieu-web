import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../app.js';
import { closeDatabase, db } from '../../db/client.js';
import { closeRedis } from '../../db/redis.js';
import { hashPassword } from '../../lib/password.js';
import {
  SEEDED_STUDENT,
  assertTestDatabase,
  flushPermissionCache,
  flushSessionCache,
} from '../../test/helpers.js';

/**
 * Public profiles.
 *
 * A profile is a view over columns somebody else owns, which makes it the
 * easiest place in the application to leak by accident — `users` holds the
 * email, the student code and `token_version`, and none of those belong on a
 * page anyone can open. The first test below is the one that matters: it reads
 * the raw response body, so a column added to the select later cannot start
 * leaking without failing an assertion.
 *
 * The rest are about the counts. A profile announces how many posts somebody
 * has and then links to them, so a count computed without the viewer's own
 * predicate would put a headline above a shorter list — the same defect as the
 * comment count that disagreed with its thread, and the same one already fixed
 * for collections and bookmarks.
 */

assertTestDatabase();

let app: FastifyInstance;
let studentToken: string;
let studentUserId: string;
let otherToken: string;
let otherUserId: string;

const OTHER_EMAIL = 'profile-other@tailieu.test';
const ANON_EMAIL = 'profile-anon@tailieu.test';
const MARKER = 'PRF-';

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

/** A confirmed account with the default student role. */
async function createUser(email: string, displayName: string): Promise<string> {
  await db.execute(sql`DELETE FROM users WHERE email = ${email}`);
  const passwordHash = await hashPassword('Other_2026!');
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

async function createPost(body: string, visibility: string, token: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/posts',
    headers: auth(token),
    payload: { body, visibility, postKind: 'status', tags: [] },
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { data: { id: string } }).data.id;
}

function getProfile(userId: string, token?: string) {
  return app.inject({
    method: 'GET',
    url: `/api/v1/users/${userId}`,
    headers: token ? auth(token) : {},
  });
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  studentToken = await login(SEEDED_STUDENT.email, SEEDED_STUDENT.password);
  const student = await db.execute<{ id: string }>(
    sql`SELECT id FROM users WHERE email = ${SEEDED_STUDENT.email}`,
  );
  studentUserId = student.rows[0]!.id;

  otherUserId = await createUser(OTHER_EMAIL, 'Người dùng hồ sơ');
  otherToken = await login(OTHER_EMAIL, 'Other_2026!');
});

afterAll(async () => {
  // Posts first: notifications and comments reference them polymorphically, so
  // nothing cascades and a leftover row would strand.
  await db.execute(sql`
    DELETE FROM notifications
     WHERE actor_user_id IN (SELECT id FROM users WHERE email IN (${OTHER_EMAIL}, ${ANON_EMAIL}))
  `);
  await db.execute(sql`
    DELETE FROM posts
     WHERE author_user_id IN (SELECT id FROM users WHERE email IN (${OTHER_EMAIL}, ${ANON_EMAIL}))
  `);
  await db.execute(sql`DELETE FROM users WHERE email IN (${OTHER_EMAIL}, ${ANON_EMAIL})`);
  await app.close();
  await closeDatabase();
  await closeRedis();
});

beforeEach(async () => {
  await flushSessionCache();
  await flushPermissionCache();
  // Each test starts with an empty post list for the fixture account, so a
  // count assertion is about this test's posts.
  await db.execute(sql`
    DELETE FROM posts WHERE author_user_id = ${otherUserId}::uuid
  `);
});

describe('a public profile', () => {
  it('exposes identity and nothing private', async () => {
    const response = await getProfile(otherUserId);
    expect(response.statusCode).toBe(200);

    // The raw body, not the parsed object: an assertion on fields the test
    // already knows about would not notice a column added to the select later.
    const raw = response.body;
    expect(raw).not.toContain(OTHER_EMAIL);
    expect(raw).not.toContain('token_version');
    expect(raw).not.toContain('tokenVersion');
    expect(raw).not.toContain('studentCode');
    expect(raw).not.toContain('password');

    const data = (response.json() as { data: { displayName: string; joinedAt: string } }).data;
    expect(data.displayName).toBe('Người dùng hồ sơ');
    expect(data.joinedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('is readable while signed out, and reports no follow state', async () => {
    const response = await getProfile(otherUserId);
    const data = (response.json() as { data: { isFollowedByViewer: boolean; permissions: { canFollow: boolean } } }).data;

    expect(data.isFollowedByViewer).toBe(false);
    // Nobody to follow with — the endpoint behind the button needs an actor.
    expect(data.permissions.canFollow).toBe(false);
  });

  it('has no profile at all once the account is anonymised', async () => {
    const anonId = await createUser(ANON_EMAIL, 'Người dùng đã xoá');
    expect((await getProfile(anonId)).statusCode).toBe(200);

    await db.execute(sql`UPDATE users SET anonymized_at = now() WHERE id = ${anonId}::uuid`);

    // 404, not an empty page: an erasure request means the account is gone, and
    // a tombstone would keep confirming the id was once real.
    expect((await getProfile(anonId)).statusCode).toBe(404);
  });

  it('404s for an id that never existed', async () => {
    const missing = '00000000-0000-4000-8000-000000000000';
    expect((await getProfile(missing)).statusCode).toBe(404);
  });
});

describe('the counts on a profile', () => {
  /**
   * The headline number has to be what the READER can see. This account has
   * three posts; a stranger may read two of them.
   */
  it('counts only the posts the viewer may read', async () => {
    await createPost(`${MARKER}bài công khai 1`, 'public', otherToken);
    await createPost(`${MARKER}bài công khai 2`, 'public', otherToken);
    await createPost(`${MARKER}bài riêng tư`, 'private', otherToken);

    const anon = (await getProfile(otherUserId)).json() as { data: { stats: { posts: number } } };
    expect(anon.data.stats.posts).toBe(2);

    const stranger = (await getProfile(otherUserId, studentToken)).json() as {
      data: { stats: { posts: number } };
    };
    expect(stranger.data.stats.posts).toBe(2);

    // The author sees their own private post, because they always could.
    const owner = (await getProfile(otherUserId, otherToken)).json() as {
      data: { stats: { posts: number } };
    };
    expect(owner.data.stats.posts).toBe(3);
  });

  it('reports the same follower numbers the follow endpoint maintains', async () => {
    const follow = await app.inject({
      method: 'PUT',
      url: `/api/v1/follows/${otherUserId}`,
      headers: auth(studentToken),
      payload: { following: true },
    });
    expect(follow.statusCode).toBe(200);

    const response = await getProfile(otherUserId, studentToken);
    const data = (response.json() as {
      data: {
        stats: { followers: number; following: number };
        isFollowedByViewer: boolean;
      };
    }).data;

    // The profile reads them through the follows service, so the number the
    // button updates and the number the header shows are the same query.
    expect(data.stats.followers).toBe(1);
    expect(data.isFollowedByViewer).toBe(true);

    await app.inject({
      method: 'PUT',
      url: `/api/v1/follows/${otherUserId}`,
      headers: auth(studentToken),
      payload: { following: false },
    });
  });

  it('marks your own profile and refuses to let you follow yourself', async () => {
    const response = await getProfile(studentUserId, studentToken);
    const data = (response.json() as {
      data: { isSelf: boolean; permissions: { canFollow: boolean } };
    }).data;

    expect(data.isSelf).toBe(true);
    expect(data.permissions.canFollow).toBe(false);

    const attempt = await app.inject({
      method: 'PUT',
      url: `/api/v1/follows/${studentUserId}`,
      headers: auth(studentToken),
      payload: { following: true },
    });
    // The hidden button is cosmetic; this is the check that actually holds.
    expect(attempt.statusCode).toBe(400);
  });
});
