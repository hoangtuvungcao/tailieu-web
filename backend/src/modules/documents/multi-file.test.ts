import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../app.js';
import { closeDatabase, db } from '../../db/client.js';
import { closeRedis } from '../../db/redis.js';
import { assertTestDatabase, flushPermissionCache, flushSessionCache } from '../../test/helpers.js';
import { SEEDED_STUDENT } from '../../test/helpers.js';

/**
 * Multi-file documents.
 *
 * The reason this suite exists is the primary-file assertion below. Files are
 * fetched for validation with `WHERE id IN (...)`, which guarantees nothing
 * about row order — Postgres returns them in whatever sequence the plan
 * produces, and it does not match the order the client sent. The attach loop
 * then assigns `isPrimary: index === 0`, so a document created from
 * `[bài giảng, sơ đồ, ghi chú]` came back with whichever file the planner
 * happened to emit first as its primary: the one the detail page previews and
 * the download button serves by default.
 *
 * Nothing caught this while documents held a single file, because with one
 * element every order is the same order. It only became observable once the
 * upload page started sending several — which is exactly the kind of latent
 * defect that needs a test asserting the ORDER, not merely the count.
 */

assertTestDatabase();

let app: FastifyInstance;
let token: string;

const MARKER = 'MULTIFILE-TEST-';

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

/**
 * A real file of each kind, so MIME sniffing has genuine bytes to inspect
 * rather than a declared type the server is right to distrust.
 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=',
  'base64',
);
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);
const TEXT = Buffer.from('# Ghi chú\n\nNội dung kiểm thử nhiều tệp.\n');

/** POST /uploads → PUT every chunk → POST complete. Returns the session id. */
async function uploadFile(fileName: string, mimeType: string, bytes: Buffer): Promise<string> {
  const intent = await app.inject({
    method: 'POST',
    url: '/api/v1/uploads',
    headers: auth(),
    payload: { fileName, sizeBytes: bytes.length, mimeType },
  });
  expect(intent.statusCode).toBeLessThan(300);
  const session = (
    intent.json() as {
      data: { uploadId: string; chunkSize: number; totalChunks: number; receivedChunks: number[] };
    }
  ).data;

  const alreadyHave = new Set(session.receivedChunks);
  for (let index = 0; index < session.totalChunks; index += 1) {
    if (alreadyHave.has(index)) continue;
    const start = index * session.chunkSize;
    const chunk = await app.inject({
      method: 'PUT',
      url: `/api/v1/uploads/${session.uploadId}/chunks/${index}`,
      headers: { ...auth(), 'content-type': 'application/octet-stream' },
      payload: bytes.subarray(start, Math.min(start + session.chunkSize, bytes.length)),
    });
    expect(chunk.statusCode).toBeLessThan(300);
  }

  const complete = await app.inject({
    method: 'POST',
    url: `/api/v1/uploads/${session.uploadId}/complete`,
    headers: auth(),
  });
  expect(complete.statusCode).toBeLessThan(300);
  return session.uploadId;
}

interface CreatedDocument {
  id: string;
  files: { id: string; originalName: string; isPrimary: boolean; fileKind: string }[];
}

/**
 * Move a document's files past the scanner gate.
 *
 * `SCAN_ENABLED=true` in the development environment means every new file
 * starts `pending` and `getDownloadUrl` refuses it until the scan worker
 * reports `clean` — which is correct, and deliberately not what this suite is
 * testing. The subject here is WHICH file the download route selects, so the
 * gate is stepped over explicitly rather than waited on. Written as a query
 * rather than a mock so the code under test is the real route, the real
 * visibility predicate and the real token minting.
 */
async function markFilesReady(documentId: string): Promise<void> {
  await db.execute(sql`
    UPDATE document_files SET status = 'ready'
     WHERE document_id = ${documentId}::uuid
  `);
}

/** Create a document from the given sessions and return it, read back. */
async function createDocument(title: string, uploadIds: string[]): Promise<CreatedDocument> {
  const taxonomy = await app.inject({ method: 'GET', url: '/api/v1/taxonomy/faculties' });
  const types = await app.inject({ method: 'GET', url: '/api/v1/taxonomy/document-types' });
  const facultyId = (taxonomy.json() as { data: { id: string }[] }).data[0]!.id;
  const documentTypeId = (types.json() as { data: { id: string }[] }).data[0]!.id;

  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/documents',
    headers: auth(),
    payload: {
      title,
      documentTypeId,
      facultyId,
      visibility: 'internal',
      uploadIds,
      tags: [],
      uploaderConfirmed: true,
    },
  });
  expect(created.statusCode).toBeLessThan(300);
  const id = (created.json() as { data: { id: string } }).data.id;

  const detail = await app.inject({
    method: 'GET',
    url: `/api/v1/documents/${id}`,
    headers: auth(),
  });
  expect(detail.statusCode).toBe(200);
  return (detail.json() as { data: CreatedDocument }).data;
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  token = await login(SEEDED_STUDENT.email, SEEDED_STUDENT.password);
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM documents WHERE title LIKE ${MARKER + '%'}`);
  await db.execute(sql`DELETE FROM upload_sessions WHERE original_name LIKE ${MARKER + '%'}`);
  await app.close();
  await closeDatabase();
  await closeRedis();
});

describe('a document with several files', () => {
  it('keeps the caller order and marks the FIRST file primary', async () => {
    // Uploaded in this order...
    const pdf = await uploadFile(`${MARKER}de-cuong.pdf`, 'application/pdf', PDF);
    const png = await uploadFile(`${MARKER}so-do.png`, 'image/png', PNG);
    const txt = await uploadFile(`${MARKER}ghi-chu.txt`, 'text/plain', TEXT);

    // ...and attached in the REVERSE of it.
    //
    // Deliberate. The bug being guarded against is a server that ignores the
    // caller's order and returns rows in whatever sequence `WHERE id IN (...)`
    // produces — which, on a small table, is the order they were inserted. A
    // request whose order matches the insert order would therefore pass
    // whether or not the server honours it, and the test would only fail on
    // the days Postgres chose a different plan. Sending the reverse makes the
    // two orders disagree, so the assertion can only hold if the order came
    // from the request.
    const document = await createDocument(`${MARKER}ba tệp`, [txt, png, pdf]);

    expect(document.files).toHaveLength(3);
    expect(document.files.map((file) => file.originalName)).toEqual([
      `${MARKER}ghi-chu.txt`,
      `${MARKER}so-do.png`,
      `${MARKER}de-cuong.pdf`,
    ]);
    expect(document.files[0]!.isPrimary).toBe(true);
    expect(document.files[0]!.fileKind).toBe('text');
    expect(document.files.filter((file) => file.isPrimary)).toHaveLength(1);
  });

  it('serves the file the caller asked for, not the primary one', async () => {
    const pdf = await uploadFile(`${MARKER}tai-lieu.pdf`, 'application/pdf', PDF);
    const txt = await uploadFile(`${MARKER}phu-luc.txt`, 'text/plain', TEXT);
    const document = await createDocument(`${MARKER}hai tệp`, [pdf, txt]);
    await markFilesReady(document.id);

    const secondary = document.files[1]!;

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/documents/${document.id}/download?fileId=${secondary.id}`,
      headers: auth(),
    });
    expect(response.statusCode).toBe(200);

    const body = (response.json() as { data: { url: string; fileName: string } }).data;
    expect(body.fileName).toBe(`${MARKER}phu-luc.txt`);

    // The token is scoped to one file. If the route ignored `fileId` and fell
    // back to the primary, this claim would name the PDF while the response
    // still reported the text file's name — so assert the claim too.
    const claim = JSON.parse(
      Buffer.from(body.url.split('token=')[1]!.split('.')[1]!, 'base64url').toString(),
    ) as { fid: string };
    expect(claim.fid).toBe(secondary.id);
  });

  it('refuses a file id that belongs to another document', async () => {
    const mine = await uploadFile(`${MARKER}cua-toi.txt`, 'text/plain', TEXT);
    const first = await createDocument(`${MARKER}tài liệu một`, [mine]);

    const other = await uploadFile(`${MARKER}khac.txt`, 'text/plain', TEXT);
    const second = await createDocument(`${MARKER}tài liệu hai`, [other]);

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/documents/${first.id}/download?fileId=${second.files[0]!.id}`,
      headers: auth(),
    });
    // 404, not 403: a caller who could tell "exists but not yours" from
    // "does not exist" could enumerate other people's file ids.
    expect(response.statusCode).toBe(404);
  });

  it('rejects more files than the configured maximum', async () => {
    const session = await uploadFile(`${MARKER}mot.txt`, 'text/plain', TEXT);
    const tooMany = Array.from({ length: 11 }, () => session);

    const taxonomy = await app.inject({ method: 'GET', url: '/api/v1/taxonomy/faculties' });
    const types = await app.inject({ method: 'GET', url: '/api/v1/taxonomy/document-types' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: auth(),
      payload: {
        title: `${MARKER}mười một tệp`,
        documentTypeId: (types.json() as { data: { id: string }[] }).data[0]!.id,
        facultyId: (taxonomy.json() as { data: { id: string }[] }).data[0]!.id,
        visibility: 'internal',
        uploadIds: tooMany,
        tags: [],
        uploaderConfirmed: true,
      },
    });
    expect(response.statusCode).toBe(422);
  });
});
