import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../app.js';
import { closeDatabase, db } from '../../db/client.js';
import { closeRedis } from '../../db/redis.js';
import {
  assertTestDatabase,
  flushPermissionCache,
  flushSessionCache,
  purgeTestUsers,
  uniqueEmail,
} from '../../test/helpers.js';

/**
 * Filing a report.
 *
 * This suite exists because `reports` had a complete reading side and no
 * writing side at all: the table, the moderation queue screen, the resolve
 * action and the reason labels were all built, and nothing anywhere inserted a
 * row. The queue could only ever be empty, which made it a screen that lied —
 * it looked like a working feature and was a dead end.
 *
 * So the tests are written against the two properties that make the writing
 * side safe rather than against its happy path alone:
 *
 *   1. **It is not an existence oracle.** "No such document" and "a document
 *      you are not allowed to see" must be indistinguishable, or the endpoint
 *      becomes a way to confirm that a guessed UUID names a real private
 *      document. The test compares the two responses byte for byte, because
 *      "both are 404" is not the same claim as "both say the same thing".
 *
 *   2. **The unique index is the guard, not a pre-check.** Filing twice must be
 *      refused, and refused by the database rather than by a SELECT that two
 *      concurrent requests would both pass.
 */

assertTestDatabase();

let app: FastifyInstance;

const OWNER = { email: uniqueEmail('report-owner'), password: 'KiemThu#2026Report' };
const REPORTER = { email: uniqueEmail('report-reporter'), password: 'KiemThu#2026Report' };

/**
 * Every document this suite creates carries this prefix in its title, so
 * teardown can find them again.
 *
 * It has to: `documents.owner_user_id` has no cascade, so a document left
 * behind blocks the delete of the account that owns it and `purgeTestUsers`
 * fails with a foreign-key error. Deleting by title rather than by owner is
 * also what keeps this suite from reaching into rows another suite is using —
 * all the test accounts share the `@tailieu.test` suffix.
 */
const MARKER = 'REPORT-TEST-';

let ownerToken: string;
let reporterToken: string;
let facultyId: string;
let documentTypeId: string;

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=',
  'base64',
);

async function register(account: { email: string; password: string }): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { ...account, displayName: 'Người kiểm thử báo cáo' },
  });
  const body = response.json() as { data?: { accessToken: string } };
  if (!body.data) throw new Error(`register failed: ${JSON.stringify(body).slice(0, 300)}`);
  return body.data.accessToken;
}

function headers(token: string) {
  return { authorization: `Bearer ${token}` };
}

/** One file, through the real chunked protocol. Returns the session id. */
async function uploadFile(token: string): Promise<string> {
  const intent = await app.inject({
    method: 'POST',
    url: '/api/v1/uploads',
    headers: headers(token),
    payload: { fileName: 'tai-lieu.png', sizeBytes: PNG.length, mimeType: 'image/png' },
  });
  const session = (
    intent.json() as {
      data: { uploadId: string; chunkSize: number; totalChunks: number; receivedChunks: number[] };
    }
  ).data;

  const alreadyHave = new Set(session.receivedChunks);
  for (let index = 0; index < session.totalChunks; index += 1) {
    if (alreadyHave.has(index)) continue;
    const start = index * session.chunkSize;
    await app.inject({
      method: 'PUT',
      url: `/api/v1/uploads/${session.uploadId}/chunks/${index}`,
      headers: { ...headers(token), 'content-type': 'application/octet-stream' },
      payload: PNG.subarray(start, Math.min(start + session.chunkSize, PNG.length)),
    });
  }

  const complete = await app.inject({
    method: 'POST',
    url: `/api/v1/uploads/${session.uploadId}/complete`,
    headers: headers(token),
  });
  expect(complete.statusCode).toBeLessThan(300);
  return session.uploadId;
}

/**
 * Create a document and force it to the state another user can see.
 *
 * The status is set with SQL rather than by driving the moderation workflow.
 * A new document starts `draft` or `pending_review` depending on its type's
 * policy, and the subject here is the report endpoint's visibility check — not
 * the review workflow, which has its own tests. Stepping over the gate
 * explicitly is honest; waiting on a moderator that this suite would have to
 * invent is not.
 *
 * `published_at` moves with `status`, because `documents_published_has_timestamp_chk`
 * requires a published document to say when — a row that claims to be live and
 * cannot be placed in time is the state that constraint exists to prevent.
 */
async function createDocument(
  token: string,
  options: { visibility: 'public' | 'internal' | 'private'; title: string },
): Promise<string> {
  const uploadId = await uploadFile(token);
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/documents',
    headers: headers(token),
    payload: {
      title: `${MARKER}${options.title}`,
      documentTypeId,
      facultyId,
      visibility: options.visibility,
      uploadIds: [uploadId],
      tags: [],
      uploaderConfirmed: true,
    },
  });
  expect(created.statusCode).toBeLessThan(300);
  const id = (created.json() as { data: { id: string } }).data.id;

  await db.execute(sql`
    UPDATE documents
       SET status = 'published', published_at = now()
     WHERE id = ${id}::uuid
  `);
  return id;
}

async function report(
  token: string,
  payload: Record<string, unknown>,
): Promise<{ statusCode: number; body: unknown }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/reports',
    headers: headers(token),
    payload,
  });
  return { statusCode: response.statusCode, body: response.json() };
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await flushSessionCache();
  await flushPermissionCache();

  ownerToken = await register(OWNER);
  reporterToken = await register(REPORTER);

  const faculties = await app.inject({ method: 'GET', url: '/api/v1/taxonomy/faculties' });
  const types = await app.inject({ method: 'GET', url: '/api/v1/taxonomy/document-types' });
  facultyId = (faculties.json() as { data: { id: string }[] }).data[0]!.id;
  documentTypeId = (types.json() as { data: { id: string }[] }).data[0]!.id;
});

afterAll(async () => {
  // Documents first: they hold the foreign key into `users`, so the accounts
  // cannot go until their content has. Reports filed against those documents
  // are deliberately NOT cleaned up here — the target is polymorphic with no
  // foreign key precisely so a report outlives the thing it names, and the rows
  // are removed with their reporter by the cascade in `purgeTestUsers`.
  await db.execute(sql`DELETE FROM documents WHERE title LIKE ${MARKER + '%'}`);
  await purgeTestUsers();
  await closeDatabase();
  await closeRedis();
  await app.close();
});

describe('POST /reports', () => {
  it('files a report against a document the reporter can see', async () => {
    const documentId = await createDocument(ownerToken, {
      visibility: 'internal',
      title: 'Tài liệu để báo cáo',
    });

    const result = await report(reporterToken, {
      targetType: 'document',
      targetId: documentId,
      reason: 'copyright',
      details: 'Tài liệu này sao chép nguyên một chương sách có bản quyền.',
    });

    expect(result.statusCode).toBe(201);
    const body = result.body as { data: { id: string; status: string } };
    expect(body.data.status).toBe('pending');
    expect(body.data.id).toBeTruthy();
  });

  it('refuses a second open report on the same target', async () => {
    const documentId = await createDocument(ownerToken, {
      visibility: 'internal',
      title: 'Tài liệu báo cáo hai lần',
    });

    const first = await report(reporterToken, {
      targetType: 'document',
      targetId: documentId,
      reason: 'spam',
    });
    expect(first.statusCode).toBe(201);

    const second = await report(reporterToken, {
      targetType: 'document',
      targetId: documentId,
      reason: 'spam',
    });
    expect(second.statusCode).toBe(409);

    // Exactly one row, not two — the partial unique index is what enforced it.
    const rows = await db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM reports
       WHERE target_id = ${documentId}::uuid AND status = 'pending'
    `);
    expect(rows.rows[0]!.count).toBe('1');
  });

  it('refuses a report on your own document', async () => {
    const documentId = await createDocument(ownerToken, {
      visibility: 'internal',
      title: 'Tài liệu của chính mình',
    });

    const result = await report(ownerToken, {
      targetType: 'document',
      targetId: documentId,
      reason: 'other',
    });

    expect(result.statusCode).toBe(422);
  });

  it('rejects a reason that is not in the enum', async () => {
    const documentId = await createDocument(ownerToken, {
      visibility: 'internal',
      title: 'Tài liệu lý do sai',
    });

    const result = await report(reporterToken, {
      targetType: 'document',
      targetId: documentId,
      reason: 'i-just-do-not-like-it',
    });

    expect(result.statusCode).toBe(422);
  });

  it('requires authentication', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/reports',
      payload: {
        targetType: 'document',
        targetId: '00000000-0000-4000-8000-000000000000',
        reason: 'spam',
      },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('POST /reports does not reveal whether a private document exists', () => {
  /**
   * The point of the whole endpoint.
   *
   * A private document and an id that names nothing must produce the SAME
   * response. If they differ by so much as a message string, anyone holding a
   * list of candidate UUIDs can sort the real documents from the invented ones
   * without ever being allowed to read either — and the ids of private
   * documents are exactly what an attacker wants.
   */
  it('answers a private document and a nonexistent one identically', async () => {
    const privateDocumentId = await createDocument(ownerToken, {
      visibility: 'private',
      title: 'Tài liệu riêng tư',
    });

    const invisible = await report(reporterToken, {
      targetType: 'document',
      targetId: privateDocumentId,
      reason: 'spam',
    });

    const nonexistent = await report(reporterToken, {
      targetType: 'document',
      targetId: '11111111-1111-4111-8111-111111111111',
      reason: 'spam',
    });

    expect(invisible.statusCode).toBe(404);
    expect(nonexistent.statusCode).toBe(404);

    // Byte for byte, not merely "both 404". The status alone is not the
    // property being claimed.
    expect(JSON.stringify(invisible.body)).toBe(JSON.stringify(nonexistent.body));

    // And nothing was written, so a rejected report cannot be used to seed the
    // moderation queue with entries about content the reporter cannot see.
    const rows = await db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM reports
       WHERE target_id = ${privateDocumentId}::uuid
    `);
    expect(rows.rows[0]!.count).toBe('0');
  });

  it('refuses to say whether a document exists when the id is malformed', async () => {
    const result = await report(reporterToken, {
      targetType: 'document',
      targetId: 'not-a-uuid',
      reason: 'spam',
    });
    expect(result.statusCode).toBe(422);
  });
});

describe('the reporter reads back their own reports', () => {
  it('reports the state, then lists the report', async () => {
    const documentId = await createDocument(ownerToken, {
      visibility: 'internal',
      title: 'Tài liệu tra cứu trạng thái',
    });

    const before = await app.inject({
      method: 'GET',
      url: `/api/v1/reports/state?targetType=document&targetId=${documentId}`,
      headers: headers(reporterToken),
    });
    expect((before.json() as { data: { reported: boolean } }).data.reported).toBe(false);

    await report(reporterToken, {
      targetType: 'document',
      targetId: documentId,
      reason: 'wrong_content',
    });

    const after = await app.inject({
      method: 'GET',
      url: `/api/v1/reports/state?targetType=document&targetId=${documentId}`,
      headers: headers(reporterToken),
    });
    expect((after.json() as { data: { reported: boolean } }).data.reported).toBe(true);

    const mine = await app.inject({
      method: 'GET',
      url: '/api/v1/reports/mine?limit=50',
      headers: headers(reporterToken),
    });
    const listed = (mine.json() as { data: { id: string; targetId: string }[] }).data;
    expect(listed.some((row) => row.targetId === documentId)).toBe(true);

    // The owner never filed anything, so their history stays empty. A list that
    // leaked other people's reports would be a disclosure, not a bug in a
    // filter.
    const ownersOwn = await app.inject({
      method: 'GET',
      url: '/api/v1/reports/mine',
      headers: headers(ownerToken),
    });
    const ownerRows = (ownersOwn.json() as { data: unknown[] }).data;
    expect(ownerRows).toHaveLength(0);
  });
});

describe('the moderator queue', () => {
  /**
   * The end-to-end claim: what a user files reaches the screen built to
   * receive it. Before this, the queue was structurally incapable of being
   * non-empty, so nothing tested it.
   */
  it('shows a user-filed report to an administrator', async () => {
    const adminEmail = process.env.SEED_ADMIN_EMAIL ?? 'admin@tailieu.local';
    const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMe_Admin_2026';

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: adminEmail, password: adminPassword },
    });
    const admin = login.json() as { data?: { accessToken: string } };
    expect(admin.data).toBeTruthy();

    const title = 'Tài liệu vào hàng đợi kiểm duyệt';
    const documentId = await createDocument(ownerToken, { visibility: 'internal', title });
    await report(reporterToken, {
      targetType: 'document',
      targetId: documentId,
      reason: 'malware',
      details: 'Tệp đính kèm có dấu hiệu mã độc.',
    });

    const queue = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/reports?status=pending&limit=100',
      headers: headers(admin.data!.accessToken),
    });
    expect(queue.statusCode).toBe(200);

    const rows = (queue.json() as { data: { targetId: string; reason: string }[] }).data;
    const found = rows.find((row) => row.targetId === documentId);
    expect(found).toBeTruthy();
    expect(found!.reason).toBe('malware');
  });

  it('refuses a plain user the queue', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/reports',
      headers: headers(reporterToken),
    });
    expect(response.statusCode).toBe(403);
  });
});
