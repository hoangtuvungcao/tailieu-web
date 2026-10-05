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
 * Comments.
 *
 * This suite exists because the module shipped with no tests at all, and the
 * bug that hid in it was invisible to every other check in the project: a
 * deleted top-level comment took its entire subtree with it. The thread came
 * back empty while the post still advertised its full comment count, so the
 * page read "3 bình luận" above nothing. Typecheck passed. The e2e script did
 * not touch comments. Nothing failed — the data was simply gone from the
 * reader's view.
 *
 * The root cause is a shape worth remembering: the repository filtered removed
 * rows out of the result set, and the service groups replies by looking up
 * their root in that same set. Filtering the root away is not tidying, it is
 * orphaning — and the failure is silent, because an empty list is a perfectly
 * valid response.
 *
 * So the assertions below are mostly about absence being *visible*: a removed
 * comment must still occupy its slot, and its words must not travel with it.
 */

assertTestDatabase();

let app: FastifyInstance;
let studentToken: string;
let studentUserId: string;
let otherToken: string;
let otherUserId: string;
let moderatorToken: string;

const OTHER_EMAIL = 'comment-other@tailieu.test';

const MARKER = 'CMT-';

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

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function createPost(): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/posts',
    headers: auth(studentToken),
    payload: {
      body: `${MARKER}bài để thử bình luận`,
      visibility: 'public',
      postKind: 'status',
      tags: [],
    },
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { data: { id: string } }).data.id;
}

async function createComment(
  postId: string,
  body: string,
  parentCommentId: string | null = null,
  token = studentToken,
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/comments',
    headers: auth(token),
    payload: { targetType: 'post', targetId: postId, body, parentCommentId },
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { data: { id: string } }).data.id;
}

interface CommentShape {
  id: string;
  body: string;
  deleted: boolean;
  author: { id: string; displayName: string };
  stats: { likes: number; replies: number };
  permissions: { canEdit: boolean; canDelete: boolean };
  replies?: CommentShape[];
}

async function listComments(
  postId: string,
  token?: string,
): Promise<{ items: CommentShape[]; total: number }> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/comments?targetType=post&targetId=${postId}&limit=50`,
    headers: token ? auth(token) : {},
  });
  expect(response.statusCode).toBe(200);
  const body = response.json() as { data: CommentShape[]; meta: { total: number } };
  return { items: body.data, total: body.meta.total };
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  studentToken = await login(SEEDED_STUDENT.email, SEEDED_STUDENT.password);
  moderatorToken = await login(
    'moderator@tailieu.local',
    process.env.SEED_MODERATOR_PASSWORD ?? 'ChangeMe_Mod_2026',
  );

  const student = await db.execute<{ id: string }>(
    sql`SELECT id FROM users WHERE email = ${SEEDED_STUDENT.email}`,
  );
  studentUserId = student.rows[0]!.id;

  await db.execute(sql`DELETE FROM users WHERE email = ${OTHER_EMAIL}`);
  const passwordHash = await hashPassword('Other_2026!');
  await db.execute(sql`
    INSERT INTO users (email, display_name, email_verified_at, status)
    VALUES (${OTHER_EMAIL}, 'Người bình luận khác', now(), 'active')
  `);
  const other = await db.execute<{ id: string }>(
    sql`SELECT id FROM users WHERE email = ${OTHER_EMAIL}`,
  );
  otherUserId = other.rows[0]!.id;
  await db.execute(sql`
    INSERT INTO auth_identities (user_id, provider, provider_uid, password_hash)
    VALUES (${otherUserId}::uuid, 'password', ${OTHER_EMAIL}, ${passwordHash})
  `);
  // The default student role, so the account can actually post a comment.
  await db.execute(sql`
    INSERT INTO user_roles (user_id, role_id)
    SELECT ${otherUserId}::uuid, r.id FROM roles r WHERE r.key = 'student'
  `);

  otherToken = await login(OTHER_EMAIL, 'Other_2026!');
});

afterAll(async () => {
  // Comments are polymorphic — there is no foreign key from `comments` to
  // `posts`, so deleting the posts would leave the comments behind.
  await db.execute(sql`
    DELETE FROM comments
     WHERE target_id IN (SELECT id FROM posts WHERE body LIKE ${MARKER + '%'})
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
});

describe('thread assembly', () => {
  it('returns top-level comments with their replies grouped underneath', async () => {
    const postId = await createPost();
    const root = await createComment(postId, 'Gốc');
    await createComment(postId, 'Trả lời 1', root);
    await createComment(postId, 'Trả lời 2', root);

    const { items, total } = await listComments(postId);

    expect(total).toBe(1);
    expect(items).toHaveLength(1);
    expect(items[0]!.body).toBe('Gốc');
    expect(items[0]!.replies?.map((r) => r.body)).toEqual(['Trả lời 1', 'Trả lời 2']);
  });

  it('refuses a reply deeper than the depth cap', async () => {
    const postId = await createPost();
    const root = await createComment(postId, 'Cấp 0');
    const one = await createComment(postId, 'Cấp 1', root);
    const two = await createComment(postId, 'Cấp 2', one);
    await createComment(postId, 'Cấp 3', two);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/comments',
      headers: auth(studentToken),
      payload: {
        targetType: 'post',
        targetId: postId,
        body: 'Cấp 4',
        parentCommentId: (await listComments(postId)).items[0]!.replies![0]!.replies![0]!
          .replies![0]!.id,
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it('refuses a reply whose parent belongs to different content', async () => {
    const postA = await createPost();
    const postB = await createPost();
    const rootOnA = await createComment(postA, 'Trên bài A');

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/comments',
      headers: auth(studentToken),
      payload: {
        targetType: 'post',
        targetId: postB,
        body: 'Gắn nhầm sang bài B',
        parentCommentId: rootOnA,
      },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('a removed comment', () => {
  /**
   * The regression this suite was written for.
   *
   * Before the fix, deleting `Gốc` made the whole list come back empty: the
   * root was filtered out of the query, so the grouping pass found no bucket
   * for its replies and dropped them silently. The two replies were alive in
   * the database the entire time.
   */
  it('keeps its replies visible when the root is deleted', async () => {
    const postId = await createPost();
    const root = await createComment(postId, 'Gốc');
    await createComment(postId, 'Trả lời 1', root);
    await createComment(postId, 'Trả lời 2', root);

    const before = await listComments(postId);
    expect(before.total).toBe(1);
    expect(before.items[0]!.replies).toHaveLength(2);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/comments/${root}`,
      headers: auth(studentToken),
    });
    expect(deleted.statusCode).toBe(200);

    const after = await listComments(postId);

    // The root's slot survives; only its content is gone.
    expect(after.total).toBe(1);
    expect(after.items).toHaveLength(1);
    expect(after.items[0]!.deleted).toBe(true);

    // And the conversation underneath it is still there. This is the assertion
    // that would have caught the bug.
    expect(after.items[0]!.replies?.map((r) => r.body)).toEqual(['Trả lời 1', 'Trả lời 2']);
  });

  it('withholds the body and the author', async () => {
    const postId = await createPost();
    const root = await createComment(postId, 'Nội dung cần được giữ kín');
    await createComment(postId, 'Trả lời', root);

    await app.inject({
      method: 'DELETE',
      url: `/api/v1/comments/${root}`,
      headers: auth(studentToken),
    });

    const { items } = await listComments(postId);
    const tombstone = items[0]!;

    // The words must not leave the server, and neither must the identity:
    // naming whoever wrote a removed comment turns a takedown into a public
    // record of who was moderated.
    expect(tombstone.body).toBe('');
    expect(tombstone.author.id).toBe('');
    expect(JSON.stringify(tombstone)).not.toContain('giữ kín');
  });

  it('offers no actions on a tombstone', async () => {
    const postId = await createPost();
    const root = await createComment(postId, 'Gốc');

    await app.inject({
      method: 'DELETE',
      url: `/api/v1/comments/${root}`,
      headers: auth(studentToken),
    });

    const { items } = await listComments(postId, studentToken);

    // Even the author, who deleted it, is offered nothing — there is no body
    // left to edit and nothing left to delete.
    expect(items[0]!.permissions).toEqual({ canEdit: false, canDelete: false });
  });

  it('cannot be replied to', async () => {
    const postId = await createPost();
    const root = await createComment(postId, 'Gốc');

    await app.inject({
      method: 'DELETE',
      url: `/api/v1/comments/${root}`,
      headers: auth(studentToken),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/comments',
      headers: auth(otherToken),
      payload: {
        targetType: 'post',
        targetId: postId,
        body: 'Trả lời vào chỗ trống',
        parentCommentId: root,
      },
    });

    expect(response.statusCode).toBe(404);
  });

  it('cannot be edited or deleted a second time', async () => {
    const postId = await createPost();
    const root = await createComment(postId, 'Gốc');

    await app.inject({
      method: 'DELETE',
      url: `/api/v1/comments/${root}`,
      headers: auth(studentToken),
    });

    const edit = await app.inject({
      method: 'PATCH',
      url: `/api/v1/comments/${root}`,
      headers: auth(studentToken),
      payload: { body: 'Hồi sinh' },
    });
    expect(edit.statusCode).toBe(404);

    const remove = await app.inject({
      method: 'DELETE',
      url: `/api/v1/comments/${root}`,
      headers: auth(studentToken),
    });
    expect(remove.statusCode).toBe(404);
  });

  it('keeps a deleted reply from orphaning its own replies', async () => {
    const postId = await createPost();
    const root = await createComment(postId, 'Gốc');
    const one = await createComment(postId, 'Cấp 1', root);
    await createComment(postId, 'Cấp 2', one);

    await app.inject({
      method: 'DELETE',
      url: `/api/v1/comments/${one}`,
      headers: auth(studentToken),
    });

    const { items } = await listComments(postId);
    const chain = items[0]!.replies![0]!;

    // Depth 1 is a tombstone, depth 2 still hangs off it.
    expect(chain.deleted).toBe(true);
    expect(chain.replies?.map((r) => r.body)).toEqual(['Cấp 2']);
  });
});

describe('the comment count on the target', () => {
  /**
   * The count is never decremented on delete — a removed comment leaves a
   * visible gap rather than silently shrinking the thread.
   *
   * The gap is what makes this coherent: the reader can see the tombstone, so
   * a count that includes it agrees with what is on screen. Before tombstones
   * existed the same rule produced a count of 3 above an empty list, which
   * looked like a rendering bug and was really a data-loss one.
   */
  it('still counts removed comments, matching the tombstone the reader sees', async () => {
    const postId = await createPost();
    const root = await createComment(postId, 'Gốc');
    await createComment(postId, 'Trả lời', root);

    const before = await app.inject({ method: 'GET', url: `/api/v1/posts/${postId}` });
    expect((before.json() as { data: { stats: { comments: number } } }).data.stats.comments).toBe(2);

    await app.inject({
      method: 'DELETE',
      url: `/api/v1/comments/${root}`,
      headers: auth(studentToken),
    });

    const after = await app.inject({ method: 'GET', url: `/api/v1/posts/${postId}` });
    const count = (after.json() as { data: { stats: { comments: number } } }).data.stats.comments;

    expect(count).toBe(2);

    // Whatever the count claims, the thread must actually show that many
    // slots — tombstones included. A count the thread cannot account for is
    // exactly the symptom the deleted-root bug produced.
    const { items } = await listComments(postId);
    const slots = items.reduce((sum, c) => sum + 1 + (c.replies?.length ?? 0), 0);
    expect(slots).toBe(count);
  });
});

describe('authorisation', () => {
  it('refuses to delete a comment written by someone else', async () => {
    const postId = await createPost();
    const root = await createComment(postId, 'Của sinh viên');

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/comments/${root}`,
      headers: auth(otherToken),
    });

    expect(response.statusCode).toBe(403);
  });

  it('refuses to edit a comment written by someone else', async () => {
    const postId = await createPost();
    const root = await createComment(postId, 'Của sinh viên');

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/comments/${root}`,
      headers: auth(otherToken),
      payload: { body: 'Đổi lời người khác' },
    });

    expect(response.statusCode).toBe(403);
  });

  it('lets a moderator remove a comment they do not own', async () => {
    const postId = await createPost();
    const root = await createComment(postId, 'Nội dung bị kiểm duyệt');

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/comments/${root}`,
      headers: auth(moderatorToken),
    });

    expect(response.statusCode).toBe(200);
  });
});

describe('a moderated comment', () => {
  /**
   * Hiding is the same shape as deleting from the reader's point of view: the
   * slot stays, the words go. The two are collapsed deliberately — telling a
   * reader which one happened would announce that a moderator acted.
   */
  it('is tombstoned without leaking its body, and leaves siblings visible', async () => {
    const postId = await createPost();
    const root = await createComment(postId, 'Gốc');
    const flagged = await createComment(postId, 'Nội dung bị ẩn', root);
    await createComment(postId, 'Trả lời lành mạnh', root);

    // Hiding is not exposed as an endpoint yet; the state is what the reader
    // sees, so it is set directly. When a moderation route lands, this test
    // should be rewritten to go through it.
    await db.execute(sql`
      UPDATE comments SET moderation_state = 'hidden' WHERE id = ${flagged}::uuid
    `);

    const { items } = await listComments(postId);
    const replies = items[0]!.replies!;

    expect(replies[0]!.deleted).toBe(true);
    expect(replies[0]!.body).toBe('');
    expect(JSON.stringify(replies)).not.toContain('bị ẩn');
    expect(replies[1]!.deleted).toBe(false);
    expect(replies[1]!.body).toBe('Trả lời lành mạnh');
  });
});
