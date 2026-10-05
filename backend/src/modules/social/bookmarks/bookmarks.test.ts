import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../../app.js';
import { closeDatabase, db } from '../../../db/client.js';
import { closeRedis } from '../../../db/redis.js';
import { hashPassword } from '../../../lib/password.js';
import {
  SEEDED_STUDENT,
  assertTestDatabase,
  flushPermissionCache,
  flushSessionCache,
} from '../../../test/helpers.js';

/**
 * Bookmarks.
 *
 * A bookmark is a private pointer, and it had two problems worth pinning down.
 *
 * The first: the list came back as bare pointers — `{ targetType, targetId }`
 * and nothing else. The visibility filter ran, so nothing leaked, but nothing
 * could be rendered either, and a bookmarks page built on it would have shown a
 * column of UUIDs. The fix is hydration, and the assertions below check that a
 * title actually arrives — because "the filter works" and "the feature works"
 * turned out to be different questions.
 *
 * The second: `listFolders` counted every row in a folder *without* the
 * visibility predicate. "Ôn thi (5)" above a list of three is the same defect as
 * the comment count that disagreed with its thread — a headline number
 * contradicting what sits under it, in the direction that reads as a loading bug
 * rather than a permission one.
 */

assertTestDatabase();

let app: FastifyInstance;
let studentToken: string;
let studentUserId: string;
let otherToken: string;
let otherUserId: string;

const OTHER_EMAIL = 'bookmark-other@tailieu.test';
const MARKER = 'BM-';
const FOLDER = `${MARKER}Ôn thi`;

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

async function createPost(body: string, token = studentToken): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/posts',
    headers: auth(token),
    payload: { body, visibility: 'public', postKind: 'status', tags: [] },
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { data: { id: string } }).data.id;
}

async function setPostVisibility(postId: string, visibility: string, token = studentToken) {
  return app.inject({
    method: 'PATCH',
    url: `/api/v1/posts/${postId}`,
    headers: auth(token),
    payload: { visibility },
  });
}

interface BookmarkShape {
  id: string;
  folder: string | null;
  savedAt: string;
  target: {
    type: string;
    id: string;
    title: string;
    visibility: string;
    owner: { id: string; displayName: string };
    stats: { likes: number; comments: number; items: number };
  };
}

async function listBookmarks(token: string, folder?: string) {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/bookmarks?limit=50${folder ? `&folder=${encodeURIComponent(folder)}` : ''}`,
    headers: auth(token),
  });
  expect(response.statusCode).toBe(200);
  return response;
}

async function listFolders(token: string): Promise<{ folder: string; total: number }[]> {
  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/bookmarks/folders',
    headers: auth(token),
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { data: { folder: string; total: number }[] }).data;
}

function setBookmark(
  target: 'document' | 'post' | 'collection',
  id: string,
  bookmarked: boolean,
  folder: string | null,
  token = studentToken,
) {
  return app.inject({
    method: 'PUT',
    url: `/api/v1/bookmarks/${target}/${id}`,
    headers: auth(token),
    payload: { bookmarked, folder },
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

  await db.execute(sql`DELETE FROM users WHERE email = ${OTHER_EMAIL}`);
  const passwordHash = await hashPassword('Other_2026!');
  await db.execute(sql`
    INSERT INTO users (email, display_name, email_verified_at, status)
    VALUES (${OTHER_EMAIL}, 'Người đăng khác', now(), 'active')
  `);
  const other = await db.execute<{ id: string }>(
    sql`SELECT id FROM users WHERE email = ${OTHER_EMAIL}`,
  );
  otherUserId = other.rows[0]!.id;
  await db.execute(sql`
    INSERT INTO auth_identities (user_id, provider, provider_uid, password_hash)
    VALUES (${otherUserId}::uuid, 'password', ${OTHER_EMAIL}, ${passwordHash})
  `);
  await db.execute(sql`
    INSERT INTO user_roles (user_id, role_id)
    SELECT ${otherUserId}::uuid, r.id FROM roles r WHERE r.key = 'student'
  `);

  otherToken = await login(OTHER_EMAIL, 'Other_2026!');
});

afterAll(async () => {
  // Bookmarks are polymorphic — no foreign key to the posts — so deleting the
  // posts would leave orphaned rows behind.
  await db.execute(sql`
    DELETE FROM bookmarks
     WHERE user_id = ${otherUserId}::uuid
        OR target_id IN (SELECT id FROM posts WHERE body LIKE ${MARKER + '%'})
  `);
  await db.execute(sql`DELETE FROM posts WHERE body LIKE ${MARKER + '%'}`);
  await db.execute(sql`DELETE FROM users WHERE email = ${OTHER_EMAIL}`);
  await app.close();
  await closeDatabase();
  await closeRedis();
});

beforeEach(async () => {
  await flushSessionCache();
  await flushPermissionCache();
  // Each test starts with neither account holding a bookmark, so an assertion
  // about a count is about this test's bookmark and not a leftover.
  await db.execute(sql`
    DELETE FROM bookmarks WHERE user_id IN (${studentUserId}::uuid, ${otherUserId}::uuid)
  `);
});

describe('the bookmarked list', () => {
  /**
   * The gap this file was written for. The endpoint already filtered correctly;
   * what it did not do was return anything a page could draw.
   */
  it('comes back with a title and an owner, not a bare pointer', async () => {
    const postId = await createPost(`${MARKER}bài để lưu`);
    await setBookmark('post', postId, true, FOLDER);

    const response = await listBookmarks(studentToken);
    const items = (response.json() as { data: BookmarkShape[] }).data;

    expect(items).toHaveLength(1);
    expect(items[0]!.target.title).toBe(`${MARKER}bài để lưu`);
    expect(items[0]!.target.owner.displayName).toBeTruthy();
    expect(items[0]!.target.type).toBe('post');
    expect(items[0]!.folder).toBe(FOLDER);
  });

  it('filters by folder', async () => {
    const postId = await createPost(`${MARKER}bài có thư mục`);
    const loose = await createPost(`${MARKER}bài không thư mục`);
    await setBookmark('post', postId, true, FOLDER);
    await setBookmark('post', loose, true, null);

    const filtered = (await listBookmarks(studentToken, FOLDER)).json() as {
      data: BookmarkShape[];
    };
    expect(filtered.data).toHaveLength(1);
    expect(filtered.data[0]!.target.id).toBe(postId);
  });

  it('is private — another account sees none of it', async () => {
    const postId = await createPost(`${MARKER}bài riêng của tôi`);
    await setBookmark('post', postId, true, FOLDER);

    const theirs = (await listBookmarks(otherToken)).json() as { data: BookmarkShape[] };
    expect(theirs.data).toHaveLength(0);
  });
});

describe('a bookmark whose target is no longer visible', () => {
  /**
   * The leak that matters. The pointer outlives the reader's access to what it
   * points at, and nothing but a re-check at read time stops the list from
   * printing a title the reader may no longer open.
   */
  it('disappears from the list, and takes its title with it', async () => {
    const postId = await createPost(`${MARKER}bài sẽ chuyển riêng tư`, otherToken);
    const put = await setBookmark('post', postId, true, FOLDER);
    expect(put.statusCode).toBe(200);

    // It is visible while it is public.
    expect((await listBookmarks(studentToken)).json()).toMatchObject({
      meta: { total: 1 },
    });

    // The author withdraws it.
    const patched = await setPostVisibility(postId, 'private', otherToken);
    expect(patched.statusCode).toBe(200);

    const response = await listBookmarks(studentToken);
    // Asserted on the raw body as well as the parsed list: a field added to the
    // DTO later would otherwise reintroduce the leak without failing anything.
    expect(response.body).not.toContain('bài sẽ chuyển riêng tư');
    expect(response.body).not.toContain(postId);

    const items = (response.json() as { data: BookmarkShape[] }).data;
    expect(items).toHaveLength(0);
  });

  it('stops being counted in its folder', async () => {
    // The second defect: `listFolders` had no visibility predicate, so the
    // sidebar counted rows the list could not show.
    const postId = await createPost(`${MARKER}bài đếm sai`, otherToken);
    await setBookmark('post', postId, true, FOLDER);

    const before = await listFolders(studentToken);
    expect(before.find((f) => f.folder === FOLDER)?.total).toBe(1);

    await setPostVisibility(postId, 'private', otherToken);

    const after = await listFolders(studentToken);
    // The count and the list have to agree. A folder reported as holding one
    // item, which when opened lists nothing, is the same contradiction as a
    // comment count that disagreed with its thread.
    const listed = (await listBookmarks(studentToken, FOLDER)).json() as {
      data: BookmarkShape[];
    };
    expect(listed.data).toHaveLength(0);
    expect(after.find((f) => f.folder === FOLDER)?.total ?? 0).toBe(0);
  });

  it('is refused on the write path, so it cannot be filed in the first place', async () => {
    const postId = await createPost(`${MARKER}bài không thấy được`, otherToken);
    await setPostVisibility(postId, 'private', otherToken);

    // 404, not 403: answering differently for "exists but forbidden" would make
    // the id space an oracle for which posts are real.
    const response = await setBookmark('post', postId, true, FOLDER);
    expect(response.statusCode).toBe(404);
  });
});

describe('filing into a folder', () => {
  /**
   * `folder` is three-valued and the three cases have to stay distinguishable.
   * Collapsing them — the obvious `.nullish().transform(v => v ?? null)` — made
   * a folder impossible to remove once set: "leave it alone" and "take it out"
   * arrived as the same request.
   */

  it('takes a bookmark out of its folder when null is sent', async () => {
    const postId = await createPost(`${MARKER}bài đổi thư mục`);
    await setBookmark('post', postId, true, FOLDER);

    const cleared = await setBookmark('post', postId, true, null);
    expect(cleared.statusCode).toBe(200);

    const items = (await listBookmarks(studentToken)).json() as { data: BookmarkShape[] };
    expect(items.data).toHaveLength(1);
    expect(items.data[0]!.folder).toBeNull();
    // And the folder it left is gone from the sidebar rather than lingering at
    // a count of zero.
    expect((await listFolders(studentToken)).find((f) => f.folder === FOLDER)).toBeUndefined();
  });

  it('leaves the folder alone when the field is omitted', async () => {
    const postId = await createPost(`${MARKER}bài giữ thư mục`);
    await setBookmark('post', postId, true, FOLDER);

    // What a toggle from a detail page sends — no folder key at all. It must
    // not silently unfiled something the user had filed.
    const toggled = await app.inject({
      method: 'PUT',
      url: `/api/v1/bookmarks/post/${postId}`,
      headers: auth(studentToken),
      payload: { bookmarked: true },
    });
    expect(toggled.statusCode).toBe(200);

    const items = (await listBookmarks(studentToken)).json() as { data: BookmarkShape[] };
    expect(items.data[0]!.folder).toBe(FOLDER);
  });
});
