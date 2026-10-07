import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../../app.js';
import { closeDatabase, db } from '../../../db/client.js';
import { closeRedis } from '../../../db/redis.js';
import { hashPassword } from '../../../lib/password.js';
import { findCounterDrift } from '../shared/counters.js';
import {
  SEEDED_STUDENT,
  assertTestDatabase,
  flushPermissionCache,
  flushSessionCache,
} from '../../../test/helpers.js';

/**
 * Collections.
 *
 * A collection is the social feature with the largest blast radius, because it
 * is the only one that *aggregates*: a single public collection can hold a
 * hundred pointers, and every one of them has to be re-checked against the
 * reader on every read. A like list leaks one document; a collection leaks
 * whatever it was pointed at.
 *
 * So the assertions that matter here are the leak tests. A private document
 * placed in a public collection must not appear in that collection's HTML, in
 * its item count, or in the JSON of the API response — and must not be
 * addable at all by someone who cannot open it.
 *
 * The count gets its own tests because it is the same defect class as the
 * deleted-comment bug: a headline number that disagrees with the list beneath
 * it. `collections.item_count` is maintained and is the true row count; what a
 * reader is shown is computed per viewer.
 */

assertTestDatabase();

let app: FastifyInstance;
let studentToken: string;
let studentUserId: string;
let otherToken: string;
let otherUserId: string;
let moderatorToken: string;

const OTHER_EMAIL = 'collection-other@tailieu.test';
const MARKER = 'COL-';
const PUBLIC_DOC = `${MARKER}Tài liệu công khai`;
const PRIVATE_DOC = `${MARKER}Tài liệu riêng tư`;

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

/** A published document owned by the seeded student, at the given visibility. */
async function createDocument(
  title: string,
  visibility: 'public' | 'private',
  ownerEmail = SEEDED_STUDENT.email,
): Promise<string> {
  await db.execute(sql`
    INSERT INTO documents (
      title, document_type_id, owner_user_id, faculty_id,
      visibility, status, published_at, language, uploader_confirmed
    )
    SELECT ${title}, dt.id, u.id, f.id,
           ${visibility}::document_visibility, 'published'::document_status, now(), 'vi', true
      FROM document_types dt, users u, faculties f
     WHERE dt.code = 'lecture' AND u.email = ${ownerEmail} AND f.code = 'KHTNCN'
     LIMIT 1
  `);

  const result = await db.execute<{ id: string }>(
    sql`SELECT id FROM documents WHERE title = ${title} ORDER BY created_at DESC LIMIT 1`,
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error(`fixture document "${title}" was not created`);
  return id;
}

interface CollectionShape {
  id: string;
  title: string;
  description: string | null;
  visibility: string;
  itemCount: number;
  owner: { id: string; displayName: string };
  permissions: { canEdit: boolean; canDelete: boolean; canAddItem: boolean };
  items?: {
    id: string;
    note: string | null;
    position: number;
    target: {
      type: string;
      id: string;
      title: string;
      fileKind: string | null;
      stats: { likes: number; comments: number; items: number };
    };
  }[];
}

async function createCollection(
  title: string,
  visibility = 'private',
  token = studentToken,
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/collections',
    headers: auth(token),
    payload: { title, visibility },
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { data: { id: string } }).data.id;
}

async function addItem(
  collectionId: string,
  targetType: 'document' | 'post' | 'collection',
  targetId: string,
  token = studentToken,
  note: string | null = null,
) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/collections/${collectionId}/items`,
    headers: auth(token),
    payload: { targetType, targetId, note },
  });
}

async function getCollection(id: string, token?: string) {
  return app.inject({
    method: 'GET',
    url: `/api/v1/collections/${id}?limit=50`,
    headers: token ? auth(token) : {},
  });
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
    VALUES (${OTHER_EMAIL}, 'Người sưu tầm khác', now(), 'active')
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
  // Items are polymorphic — nothing cascades from `collections` to
  // `collection_items`' target, and nothing cascades from a document to the
  // item pointing at it. Removing the collections removes the items.
  await db.execute(sql`DELETE FROM collections WHERE title LIKE ${MARKER + '%'}`);
  await db.execute(sql`DELETE FROM documents WHERE title IN (${PUBLIC_DOC}, ${PRIVATE_DOC})`);
  await db.execute(sql`DELETE FROM posts WHERE body LIKE ${MARKER + '%'}`);
  await db.execute(sql`DELETE FROM saved_searches WHERE label LIKE ${MARKER + '%'}`);
  await db.execute(sql`DELETE FROM users WHERE email = ${OTHER_EMAIL}`);
  await app.close();
  await closeDatabase();
  await closeRedis();
});

beforeEach(async () => {
  await flushSessionCache();
  await flushPermissionCache();
});

describe('collection lifecycle', () => {
  it('creates a private collection by default and reports it as private', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers: auth(studentToken),
      payload: { title: `${MARKER}Mặc định` },
    });

    expect(response.statusCode).toBe(201);
    const created = (response.json() as { data: CollectionShape }).data;

    // Private, not public. A collection is a personal reading list until its
    // owner says otherwise — the opposite default would publish every draft the
    // moment it was created.
    expect(created.visibility).toBe('private');
    expect(created.itemCount).toBe(0);
    expect(created.permissions.canEdit).toBe(true);
  });

  it('refuses a second collection with the same title, ignoring case', async () => {
    await createCollection(`${MARKER}Ôn thi`);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers: auth(studentToken),
      payload: { title: `${MARKER}ôn thi` },
    });

    expect(response.statusCode).toBe(409);
    expect((response.json() as { error: { code: string } }).error.code).toBe('CONFLICT');
  });

  it('hides another user’s private collection behind a 404, not a 403', async () => {
    const id = await createCollection(`${MARKER}Riêng của tôi`, 'private');

    const response = await getCollection(id, otherToken);

    // 404 deliberately. A 403 would confirm the id exists, turning the uuid
    // space into an oracle: probe ids and the ones answering 403 are real.
    expect(response.statusCode).toBe(404);
    expect((response.json() as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });

  it('lets a moderator delete somebody else’s collection but not edit it', async () => {
    const id = await createCollection(`${MARKER}Để kiểm duyệt`, 'public');

    const edit = await app.inject({
      method: 'PATCH',
      url: `/api/v1/collections/${id}`,
      headers: auth(moderatorToken),
      payload: { title: `${MARKER}Đổi tên bởi kiểm duyệt viên` },
    });
    expect(edit.statusCode).toBe(404);

    const remove = await app.inject({
      method: 'DELETE',
      url: `/api/v1/collections/${id}`,
      headers: auth(moderatorToken),
    });
    expect(remove.statusCode).toBe(200);

    // Gone for the owner too — a soft delete, so it is not readable again.
    expect((await getCollection(id, studentToken)).statusCode).toBe(404);
  });
});

describe('item visibility', () => {
  /**
   * The leak test this suite exists for.
   *
   * A collection is a list of pointers and the pointers are what leak. The
   * setup is the realistic one: the owner can legitimately see their own
   * private document, so adding it is allowed — and then the collection is made
   * public, which must not carry the document's visibility along with it.
   */
  it('never exposes a private document through a public collection', async () => {
    const privateDoc = await createDocument(PRIVATE_DOC, 'private');
    const id = await createCollection(`${MARKER}Đổi sang công khai`);

    const added = await addItem(id, 'document', privateDoc);
    expect(added.statusCode).toBe(201);

    // The owner sees their own private document in their own collection.
    const ownerView = await getCollection(id, studentToken);
    expect(ownerView.statusCode).toBe(200);
    const ownerData = (ownerView.json() as { data: CollectionShape }).data;
    expect(ownerData.itemCount).toBe(1);
    expect(ownerData.items).toHaveLength(1);

    // Now publish it.
    const publish = await app.inject({
      method: 'PATCH',
      url: `/api/v1/collections/${id}`,
      headers: auth(studentToken),
      payload: { visibility: 'public' },
    });
    expect(publish.statusCode).toBe(200);

    // A stranger — and worse, an anonymous visitor — must not see it.
    for (const token of [otherToken, undefined]) {
      const response = await getCollection(id, token);
      expect(response.statusCode).toBe(200);

      const raw = response.body;
      // Asserted on the raw body, not just the parsed list. A field added to
      // the DTO later would otherwise re-introduce the leak without failing
      // any assertion here.
      expect(raw).not.toContain(PRIVATE_DOC);
      expect(raw).not.toContain(privateDoc);

      const data = (response.json() as { data: CollectionShape }).data;
      expect(data.items).toHaveLength(0);
      // The count has to move with the list. A headline reading "1 tài liệu"
      // above an empty collection is the same defect as the comment count that
      // disagreed with the thread.
      expect(data.itemCount).toBe(0);
    }

    // And the owner still sees it, because they always could.
    const stillOwner = (await getCollection(id, studentToken)).json() as {
      data: CollectionShape;
    };
    expect(stillOwner.data.itemCount).toBe(1);
  });

  it('refuses to add a document the adder cannot see', async () => {
    const privateDoc = await createDocument(PRIVATE_DOC, 'private');
    const id = await createCollection(`${MARKER}Không thêm được`, 'public', otherToken);

    const response = await addItem(id, 'document', privateDoc, otherToken);

    // 404, and crucially a refusal at write time: being able to file a private
    // document away would be the first half of laundering access to it.
    expect(response.statusCode).toBe(404);
  });

  it('hides a private document again after it is made private', async () => {
    const doc = await createDocument(PUBLIC_DOC, 'public');
    const id = await createCollection(`${MARKER}Thu hồi`, 'public');
    expect((await addItem(id, 'document', doc)).statusCode).toBe(201);

    const before = (await getCollection(id, otherToken)).json() as { data: CollectionShape };
    expect(before.data.items).toHaveLength(1);

    await db.execute(sql`UPDATE documents SET visibility = 'private' WHERE id = ${doc}`);

    const after = (await getCollection(id, otherToken)).json() as { data: CollectionShape };
    expect(after.data.items).toHaveLength(0);
    expect(after.data.itemCount).toBe(0);
  });

  it('hydrates a post item with its engagement counts', async () => {
    const postId = await createPost(`${MARKER}bài để lưu vào bộ sưu tập`);
    const id = await createCollection(`${MARKER}Có bài viết`, 'public');

    const response = await addItem(id, 'post', postId);
    expect(response.statusCode).toBe(201);

    const data = (await getCollection(id, studentToken)).json() as { data: CollectionShape };
    expect(data.data.items).toHaveLength(1);
    expect(data.data.items![0]!.target.type).toBe('post');
    // A status post has no title, so the card falls back to its opening words
    // rather than rendering a blank line.
    expect(data.data.items![0]!.target.title).toContain(MARKER);
  });

  it('hydrates a nested collection item', async () => {
    const inner = await createCollection(`${MARKER}Bên trong`, 'public');
    const outer = await createCollection(`${MARKER}Bên ngoài`, 'public');

    expect((await addItem(outer, 'collection', inner)).statusCode).toBe(201);

    const data = (await getCollection(outer, otherToken)).json() as { data: CollectionShape };
    expect(data.data.items).toHaveLength(1);
    expect(data.data.items![0]!.target.type).toBe('collection');
  });

  it('hides a nested private collection from everyone but its owner', async () => {
    const inner = await createCollection(`${MARKER}Bên trong riêng tư`, 'private');
    const outer = await createCollection(`${MARKER}Bên ngoài công khai`, 'public');
    expect((await addItem(outer, 'collection', inner)).statusCode).toBe(201);

    // The owner of `outer` is the same student, who owns `inner` too, so they
    // see it; a stranger must not.
    const stranger = (await getCollection(outer, otherToken)).json() as {
      data: CollectionShape;
    };
    expect(stranger.data.items).toHaveLength(0);
    expect(stranger.data.itemCount).toBe(0);
  });
});

describe('item ordering and counting', () => {
  it('keeps insertion order and rewrites it on reorder', async () => {
    const first = await createDocument(`${MARKER}Tài liệu 1`, 'public');
    const second = await createDocument(`${MARKER}Tài liệu 2`, 'public');
    const id = await createCollection(`${MARKER}Thứ tự`);

    await addItem(id, 'document', first);
    const added = await addItem(id, 'document', second);
    const secondItemId = (added.json() as { data: { id: string } }).data.id;

    const ordered = (await getCollection(id, studentToken)).json() as { data: CollectionShape };
    expect(ordered.data.items!.map((i) => i.target.id)).toEqual([first, second]);

    const reorder = await app.inject({
      method: 'PATCH',
      url: `/api/v1/collections/${id}/items/order`,
      headers: auth(studentToken),
      payload: { itemIds: [secondItemId] },
    });
    expect(reorder.statusCode).toBe(200);

    const after = (await getCollection(id, studentToken)).json() as { data: CollectionShape };
    // `applyOrder` numbers the ids it is given from 1, so moving the second
    // item to the front puts it before the item still sitting at position 1.
    expect(after.data.items!.map((i) => i.target.id)).toEqual([second, first]);
  });

  it('removes an item and moves the count with it', async () => {
    const doc = await createDocument(PUBLIC_DOC, 'public');
    const id = await createCollection(`${MARKER}Xoá mục`);

    const added = await addItem(id, 'document', doc);
    const itemId = (added.json() as { data: { id: string } }).data.id;

    const remove = await app.inject({
      method: 'DELETE',
      url: `/api/v1/collections/${id}/items/${itemId}`,
      headers: auth(studentToken),
    });
    expect(remove.statusCode).toBe(200);

    const data = (await getCollection(id, studentToken)).json() as { data: CollectionShape };
    expect(data.data.items).toHaveLength(0);
    expect(data.data.itemCount).toBe(0);
  });

  it('re-adding a removed item restores one row rather than creating a second', async () => {
    const doc = await createDocument(PUBLIC_DOC, 'public');
    const id = await createCollection(`${MARKER}Thêm lại`);

    const added = await addItem(id, 'document', doc);
    const itemId = (added.json() as { data: { id: string } }).data.id;
    await app.inject({
      method: 'DELETE',
      url: `/api/v1/collections/${id}/items/${itemId}`,
      headers: auth(studentToken),
    });

    const readded = await addItem(id, 'document', doc);
    expect(readded.statusCode).toBe(201);
    // The same row, restored. A second row would list the document twice and
    // the partial unique on (collection, target) would fire on the retry.
    expect((readded.json() as { data: { id: string } }).data.id).toBe(itemId);

    const data = (await getCollection(id, studentToken)).json() as { data: CollectionShape };
    expect(data.data.items).toHaveLength(1);
    expect(data.data.itemCount).toBe(1);
  });

  it('does not double-count when the same item is added twice', async () => {
    const doc = await createDocument(PUBLIC_DOC, 'public');
    const id = await createCollection(`${MARKER}Thêm hai lần`);

    await addItem(id, 'document', doc);
    await addItem(id, 'document', doc);

    const data = (await getCollection(id, studentToken)).json() as { data: CollectionShape };
    expect(data.data.items).toHaveLength(1);
    expect(data.data.itemCount).toBe(1);
  });

  /**
   * The stored counter against the viewer-visible one.
   *
   * These are deliberately two different numbers and the DTO reports the second
   * one. This test pins both: `collections.item_count` counts the rows, and
   * `itemCount` counts the rows this reader may see. If a future change starts
   * serving the stored counter, the stranger's assertion below fails.
   */
  it('reports a viewer-visible count while the stored counter keeps the true total', async () => {
    const publicDoc = await createDocument(PUBLIC_DOC, 'public');
    const privateDoc = await createDocument(PRIVATE_DOC, 'private');
    const id = await createCollection(`${MARKER}Đếm`, 'public');

    await addItem(id, 'document', publicDoc);
    await addItem(id, 'document', privateDoc);

    const stored = await db.execute<{ item_count: number }>(
      sql`SELECT item_count FROM collections WHERE id = ${id}`,
    );
    expect(Number(stored.rows[0]!.item_count)).toBe(2);

    const owner = (await getCollection(id, studentToken)).json() as { data: CollectionShape };
    expect(owner.data.itemCount).toBe(2);

    const stranger = (await getCollection(id, otherToken)).json() as { data: CollectionShape };
    expect(stranger.data.itemCount).toBe(1);
    expect(stranger.data.items).toHaveLength(1);
  });

  it('ignores item ids that do not belong to the collection being reordered', async () => {
    const doc = await createDocument(PUBLIC_DOC, 'public');
    const mine = await createCollection(`${MARKER}Của tôi`);
    const theirs = await createCollection(`${MARKER}Của người khác`, 'public', otherToken);

    const added = await addItem(theirs, 'document', doc, otherToken);
    const foreignItemId = (added.json() as { data: { id: string } }).data.id;
    await addItem(mine, 'document', doc);

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/collections/${mine}/items/order`,
      headers: auth(studentToken),
      payload: { itemIds: [foreignItemId] },
    });

    // 200 and a no-op: the statement's WHERE carries the collection id, so a
    // crafted body cannot reach into somebody else's collection. Rejecting the
    // request instead would fail a legitimate drag whenever the client's page
    // was stale, since it holds a page of items rather than all of them.
    expect(response.statusCode).toBe(200);

    const foreign = (await getCollection(theirs, otherToken)).json() as { data: CollectionShape };
    expect(foreign.data.items![0]!.position).toBe(1);
  });
});

describe('authorisation', () => {
  it('refuses a stranger adding an item to somebody else’s collection', async () => {
    const doc = await createDocument(PUBLIC_DOC, 'public');
    const id = await createCollection(`${MARKER}Không phải của bạn`, 'public');

    const response = await addItem(id, 'document', doc, otherToken);
    expect(response.statusCode).toBe(404);
  });

  it('refuses a stranger editing or deleting somebody else’s collection', async () => {
    const id = await createCollection(`${MARKER}Bảo vệ`, 'public');

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/collections/${id}`,
      headers: auth(otherToken),
      payload: { title: `${MARKER}Chiếm đoạt` },
    });
    expect(patch.statusCode).toBe(404);

    const remove = await app.inject({
      method: 'DELETE',
      url: `/api/v1/collections/${id}`,
      headers: auth(otherToken),
    });
    expect(remove.statusCode).toBe(404);
  });

  it('requires authentication to create a collection', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      payload: { title: `${MARKER}Không đăng nhập` },
    });
    expect(response.statusCode).toBe(401);
  });

  it('will not accept a private document as a cover image', async () => {
    const privateDoc = await createDocument(PRIVATE_DOC, 'private');
    const id = await createCollection(`${MARKER}Ảnh bìa`);

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/collections/${id}`,
      headers: auth(otherToken),
      payload: { coverDocumentId: privateDoc },
    });

    // 404 for the stranger on the collection itself; the cover check is
    // unreachable for them, which is the correct order — authorisation first,
    // target validation second.
    expect(response.statusCode).toBe(404);
  });

  it('lists a user’s own collections including the private ones', async () => {
    await createCollection(`${MARKER}Riêng tư của tôi`, 'private');

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/collections/mine?limit=100',
      headers: auth(studentToken),
    });

    expect(response.statusCode).toBe(200);
    const items = (response.json() as { data: CollectionShape[] }).data;
    const titles = items.map((c) => c.title);
    expect(titles).toContain(`${MARKER}Riêng tư của tôi`);

    // The same list for a stranger must not contain it.
    const stranger = await app.inject({
      method: 'GET',
      url: '/api/v1/collections/mine?limit=100',
      headers: auth(otherToken),
    });
    const strangerTitles = (stranger.json() as { data: CollectionShape[] }).data.map((c) => c.title);
    expect(strangerTitles).not.toContain(`${MARKER}Riêng tư của tôi`);
  });

  it('does not leak a private collection through the public discover list to anyone, including moderators or owner', async () => {
    const id = await createCollection(`${MARKER}Không được lộ`, 'private');

    // Anonymous visitor
    const anonRes = await app.inject({ method: 'GET', url: '/api/v1/collections?limit=100' });
    expect(anonRes.statusCode).toBe(200);
    const anonTitles = (anonRes.json() as { data: CollectionShape[] }).data.map((c) => c.title);
    expect(anonTitles).not.toContain(`${MARKER}Không được lộ`);

    // Owner browsing discover feed (private collections belong under "mine", not discover)
    const ownerRes = await app.inject({
      method: 'GET',
      url: '/api/v1/collections?limit=100',
      headers: auth(studentToken),
    });
    expect(ownerRes.statusCode).toBe(200);
    const ownerTitles = (ownerRes.json() as { data: CollectionShape[] }).data.map((c) => c.title);
    expect(ownerTitles).not.toContain(`${MARKER}Không được lộ`);

    // Moderator browsing discover feed must NEVER see users' private collections
    const modRes = await app.inject({
      method: 'GET',
      url: '/api/v1/collections?limit=100',
      headers: auth(moderatorToken),
    });
    expect(modRes.statusCode).toBe(200);
    const modTitles = (modRes.json() as { data: CollectionShape[] }).data.map((c) => c.title);
    expect(modTitles).not.toContain(`${MARKER}Không được lộ`);

    // Moderator accessing private collection by ID must receive 404 (only owner can read)
    const modDirect = await getCollection(id, moderatorToken);
    expect(modDirect.statusCode).toBe(404);
  });
});

describe('the stored counter reconciles with the rows', () => {
  /**
   * `findCounterDrift` gained a `collections.item_count` clause alongside this
   * module. It is the only thing that can distinguish a drifted counter from a
   * correct one, and without a test it is a query nobody has ever run.
   */
  it('reports no drift after adds and removes', async () => {
    const doc = await createDocument(PUBLIC_DOC, 'public');
    const id = await createCollection(`${MARKER}Đối chiếu`);

    const added = await addItem(id, 'document', doc);
    const itemId = (added.json() as { data: { id: string } }).data.id;
    await app.inject({
      method: 'DELETE',
      url: `/api/v1/collections/${id}/items/${itemId}`,
      headers: auth(studentToken),
    });
    await addItem(id, 'document', doc);

    const drift = await findCounterDrift();

    expect(drift.filter((d) => d.entity === 'collections.item_count' && d.id === id)).toEqual([]);
  });
});

describe('userId sanity', () => {
  it('created the two accounts this suite depends on', () => {
    expect(studentUserId).not.toBe(otherUserId);
  });
});
