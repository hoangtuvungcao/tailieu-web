import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../../app.js';
import { closeDatabase, db } from '../../../db/client.js';
import { closeRedis } from '../../../db/redis.js';
import { assertTestDatabase, flushPermissionCache, flushSessionCache } from '../../../test/helpers.js';
import { SEEDED_STUDENT } from '../../../test/helpers.js';

/**
 * Feed pagination.
 *
 * The reason this suite exists is the contrast in the first test. With OFFSET
 * pagination, a post published while the reader is on page 1 shifts every later
 * row down by one, so page 2 begins with the last row of page 1 — the reader
 * sees the same post twice and never sees the one that was pushed past the
 * boundary. That is not an edge case on a feed people leave open; it is the
 * ordinary case, and it is invisible because a repeated row looks like nothing
 * went wrong.
 *
 * The posts here are created with explicit, distinct timestamps rather than
 * `now()`. Two posts made in the same millisecond order by their random uuid,
 * so an assertion about which row lands on which page would pass or fail
 * depending on the ids — a flaky test that would eventually be "fixed" by
 * weakening the assertion instead of the code.
 */

assertTestDatabase();

let app: FastifyInstance;
let token: string;
let userId: string;

const MARKER = 'PG-';

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

function auth() {
  return { authorization: `Bearer ${token}` };
}

/** A post whose `created_at` is set explicitly, so page order is deterministic. */
async function createPostAt(body: string, minutesAgo: number): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/posts',
    headers: auth(),
    payload: { body: `${MARKER}${body}`, visibility: 'public', postKind: 'status', tags: [] },
  });
  expect(response.statusCode).toBe(201);
  const id = (response.json() as { data: { id: string } }).data.id;

  await db.execute(sql`
    UPDATE posts SET created_at = now() - (${minutesAgo} * interval '1 minute')
     WHERE id = ${id}::uuid
  `);
  return id;
}

interface ListShape {
  data: { id: string }[];
  meta: { nextCursor?: string | null; total?: number; totalPages?: number; limit: number };
}

async function list(query: string, withAuth = true): Promise<ListShape> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/posts?${query}`,
    headers: withAuth ? auth() : {},
  });
  expect(response.statusCode).toBe(200);
  return response.json() as ListShape;
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  token = await login(SEEDED_STUDENT.email, SEEDED_STUDENT.password);
  const me = await db.execute<{ id: string }>(
    sql`SELECT id FROM users WHERE email = ${SEEDED_STUDENT.email}`,
  );
  userId = me.rows[0]!.id;
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM posts WHERE body LIKE ${MARKER + '%'}`);
  await app.close();
  await closeDatabase();
  await closeRedis();
});

beforeEach(async () => {
  await flushSessionCache();
  await flushPermissionCache();
  await db.execute(sql`DELETE FROM posts WHERE body LIKE ${MARKER + '%'}`);
});

describe('keyset pagination', () => {
  it('does not repeat a row when something is published between pages', async () => {
    // Five posts, newest first: 1m, 2m, 3m, 4m, 5m ago.
    for (let i = 1; i <= 5; i += 1) await createPostAt(`bài ${i}`, i);

    const first = await list('limit=2&sort=newest');
    const firstIds = first.data.map((row) => row.id);
    expect(firstIds).toHaveLength(2);
    const cursor = first.meta.nextCursor;
    expect(cursor).toBeTruthy();

    // Somebody posts while the reader is looking at page 1.
    await createPostAt('bài xen vào', 0);

    // Cursor: the next page continues from the last row seen, so the new post
    // is simply not in it and nothing repeats.
    const second = await list(`limit=2&sort=newest&cursor=${encodeURIComponent(cursor!)}`);
    const secondIds = second.data.map((row) => row.id);
    expect(secondIds).toHaveLength(2);
    expect(secondIds.filter((id) => firstIds.includes(id))).toEqual([]);

    // Offset: the whole list shifted down, so page 2 begins with a post the
    // reader already saw. This is the bug, asserted rather than described —
    // if a future change makes offset safe, this half should be deleted.
    const offsetSecond = await list('limit=2&page=2&sort=newest');
    const offsetIds = offsetSecond.data.map((row) => row.id);
    expect(offsetIds.some((id) => firstIds.includes(id))).toBe(true);
  });

  it('stops offering a cursor on the last page', async () => {
    for (let i = 1; i <= 3; i += 1) await createPostAt(`bài ${i}`, i);

    const first = await list('limit=2&sort=newest');
    expect(first.meta.nextCursor).toBeTruthy();

    const second = await list(`limit=2&sort=newest&cursor=${encodeURIComponent(first.meta.nextCursor!)}`);
    expect(second.data).toHaveLength(1);
    // Null rather than absent: "no more" and "the field was forgotten" must not
    // look the same to a client that scrolls until it stops.
    expect(second.meta.nextCursor).toBeNull();
  });

  it('walks the whole feed exactly once', async () => {
    for (let i = 1; i <= 7; i += 1) await createPostAt(`bài ${i}`, i);

    const seen: string[] = [];
    let cursor: string | null | undefined = undefined;
    let pages = 0;

    while (pages < 10) {
      const query = cursor ? `limit=3&sort=newest&cursor=${encodeURIComponent(cursor)}` : 'limit=3&sort=newest';
      const page = await list(query);
      seen.push(...page.data.map((row) => row.id));
      pages += 1;
      cursor = page.meta.nextCursor;
      if (!cursor) break;
    }

    expect(pages).toBe(3);
    expect(seen).toHaveLength(7);
    // No duplicates across the whole walk.
    expect(new Set(seen).size).toBe(7);
  });

  it('reports no total, because it never counts', async () => {
    for (let i = 1; i <= 3; i += 1) await createPostAt(`bài ${i}`, i);

    const page = await list('limit=2&sort=newest');
    // The count is the expensive half of OFFSET and a cursor does not need it.
    expect(page.meta.total).toBeUndefined();
    expect(page.meta.totalPages).toBeUndefined();
    expect(page.meta.nextCursor).toBeTruthy();
  });

  it('keeps the offset mode working, with its total', async () => {
    for (let i = 1; i <= 3; i += 1) await createPostAt(`bài ${i}`, i);

    const page = await list('limit=2&page=1&sort=newest');
    expect(page.meta.total).toBe(3);
    expect(page.meta.totalPages).toBe(2);
    expect(page.meta.nextCursor).toBeUndefined();
  });

  it('ignores a cursor on the popular sort', async () => {
    for (let i = 1; i <= 3; i += 1) await createPostAt(`bài ${i}`, i);

    const newest = await list('limit=2&sort=newest');
    const cursor = newest.meta.nextCursor!;

    // `hot_score` moves with every like, so a position in that ordering is not
    // stable — a cursor there would skip rows that rose and repeat rows that
    // fell. Popular stays on offset, where the failure mode is a repeat rather
    // than a silent omission.
    const popular = await list(`limit=2&sort=popular&cursor=${encodeURIComponent(cursor)}`);
    expect(popular.meta.total).toBe(3);
    expect(popular.meta.nextCursor).toBeUndefined();
  });

  it('rejects a cursor it did not issue', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/posts?limit=2&cursor=not-a-real-cursor',
      headers: auth(),
    });

    // 400, not a silent fall back to page 1: a broken cursor that quietly
    // restarts the feed looks like a refresh, and the reader never finds out.
    expect(response.statusCode).toBe(400);
  });

  it('applies the viewer’s visibility rule to every page of the walk', async () => {
    for (let i = 1; i <= 4; i += 1) await createPostAt(`bài công khai ${i}`, i);

    const hidden = await createPostAt('bài riêng tư', 10);
    await db.execute(sql`UPDATE posts SET visibility = 'private' WHERE id = ${hidden}::uuid`);

    const seen: string[] = [];
    let cursor: string | null | undefined = undefined;
    for (let i = 0; i < 5; i += 1) {
      const query = cursor ? `limit=2&sort=newest&cursor=${encodeURIComponent(cursor)}` : 'limit=2&sort=newest';
      const page = await list(query, false);
      seen.push(...page.data.map((row) => row.id));
      cursor = page.meta.nextCursor;
      if (!cursor) break;
    }

    // Walking by cursor must not be a way around the predicate — the second
    // page is exactly where a filter applied only to the first would show.
    expect(seen).not.toContain(hidden);
  });
});
