import { Readable } from 'node:stream';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../app.js';
import { closeDatabase, db } from '../../db/client.js';
import { closeRedis } from '../../db/redis.js';
import { verifyMediaToken } from '../../lib/media-token.js';
import { hashPassword } from '../../lib/password.js';
import { setStorage } from '../../lib/storage/index.js';
import type { StorageDriver } from '../../lib/storage/storage.interface.js';
import {
  SEEDED_STUDENT,
  assertTestDatabase,
  flushPermissionCache,
  flushSessionCache,
} from '../../test/helpers.js';

/**
 * Profile images, the public media route, and the document content route.
 *
 * WHY THE CONTENT ROUTE IS TESTED HERE AND NOT ONLY THROUGH THE BROWSER.
 *
 * It authorizes with a token in the QUERY STRING rather than an Authorization
 * header, because an `<img>`, an `<object>` and an `<a download>` cannot send a
 * header. That is a real weakening of the usual shape — the credential ends up
 * in a URL, in history and in any proxy log — so it is compensated elsewhere,
 * and every compensation is an assertion below:
 *
 *   the token names one file, and the route refuses a mismatched pair
 *   a token for a document you may read does not fetch a different document
 *   the URL is on OUR origin, which is the whole point of the change
 *
 * The last one is the regression test for the bug that prompted all of this:
 * preview and download used to redirect to a signed URL on the storage host.
 * The browser treats that host as a third party, partitions storage for it, and
 * logs "Partitioned cookie or storage access was provided" on the product's
 * most-used feature — and the `<a download>` attribute is ignored cross-origin,
 * so the file saved under its UUID instead of its name. A test asserting
 * "the URL is relative and points at /api/v1" is what stops that returning.
 *
 * Storage is a fake, installed through the module's own `setStorage` hook. The
 * bucket round trip belongs in the end-to-end suite, which has a real
 * SeaweedFS; what is verified here is everything that happens before and around
 * it, and the whole of the range arithmetic.
 */

assertTestDatabase();

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_BYTES = Buffer.from(PNG_BASE64, 'base64');

/** A tiny but structurally complete PDF — see the e2e fixture for the shape. */
const PDF_BYTES = Buffer.from(
  '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n',
);

/** A well-formed UUID that is not any file in this fixture. */
const UNRELATED_ID = '11111111-1111-4111-8111-111111111111';

const DOC_TITLE = 'ZZZ Media fixture — nội dung tài liệu';
const OTHER_EMAIL = 'media-other@tailieu.test';
const OTHER_PASSWORD = 'Media_2026!';

let app: FastifyInstance;
let session: Session;
let token: string;
let otherSession: Session;
let otherToken: string;
let userId: string;
let otherUserId: string;
let documentId: string;
let fileId: string;

function auth(value: string) {
  return { authorization: `Bearer ${value}` };
}

/**
 * A storage driver that answers from memory.
 *
 * Every method is present so a call this test does not expect fails loudly
 * rather than reading `undefined` — a silent `undefined.putStream` is how a
 * test starts passing for the wrong reason.
 */
function installFakeStorage(overrides: Partial<StorageDriver>): void {
  const fake = new Proxy({} as Record<string, unknown>, {
    get: (_target, property) => {
      const key = String(property);
      if (key in overrides) return (overrides as Record<string, unknown>)[key];
      return () => {
        throw new Error(`fake storage: ${key} was not expected to be called`);
      };
    },
  });

  setStorage(fake as unknown as StorageDriver);
}

/** The fake the content and media routes read bytes through. */
function installReadableStorage(): void {
  installFakeStorage({
    objectSize: async () => PDF_BYTES.length,
    getStream: async (_location, options) => {
      const range = options?.range;
      if (!range) return Readable.from([PDF_BYTES]);
      const end = range.end === undefined ? PDF_BYTES.length : range.end + 1;
      return Readable.from([PDF_BYTES.subarray(range.start, end)]);
    },
  });
}

/** The fake an image upload writes through, recording what it was asked to store. */
const puts: { key: string; contentType: string; bytes: number }[] = [];
const deletes: string[] = [];

function installWritableStorage(): void {
  puts.length = 0;
  deletes.length = 0;

  installFakeStorage({
    putStream: async (options) => {
      puts.push({
        key: options.key,
        contentType: options.contentType,
        bytes: 0,
      });
      return { contentHash: 'a'.repeat(64), sizeBytes: 0, etag: undefined };
    },
    deleteObject: async (location) => {
      deletes.push(location.key);
    },
  });
}

/** Pull a cookie value out of a Set-Cookie header list. */
function cookieFrom(headers: Record<string, unknown>, name: string): string | null {
  const raw = headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  for (const entry of list) {
    const match = new RegExp(`^${name}=([^;]*)`).exec(entry);
    if (match && match[1]) return match[1];
  }
  return null;
}

/**
 * A login, with both halves of the session.
 *
 * The access token is not enough for anything that writes. The auth routes are
 * behind a double-submit CSRF check — a non-httpOnly `csrf` cookie must be
 * echoed in `x-csrf-token` — and a request without it is refused with 403 before
 * it reaches the handler. A test carrying only the bearer token therefore looks
 * like a permissions failure when it is nothing of the sort, which is exactly
 * how this suite first failed.
 */
interface Session {
  token: string;
  csrf: string;
}

async function login(email: string, password: string): Promise<Session> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password },
  });
  const body = response.json() as { data?: { accessToken: string } };
  if (!body.data) throw new Error(`login failed for ${email}`);

  const csrf = cookieFrom(response.headers, 'csrf');
  if (!csrf) throw new Error(`login returned no csrf cookie for ${email}`);

  return { token: body.data.accessToken, csrf };
}

/** Headers for a request that changes state, as opposed to a plain read. */
function write(session: Session): Record<string, string> {
  return {
    ...auth(session.token),
    cookie: `csrf=${session.csrf}`,
    'x-csrf-token': session.csrf,
  };
}

async function createUser(email: string, displayName: string): Promise<string> {
  await db.execute(sql`DELETE FROM users WHERE email = ${email}`);
  const passwordHash = await hashPassword(OTHER_PASSWORD);
  await db.execute(sql`
    INSERT INTO users (email, display_name, email_verified_at, status)
    VALUES (${email}, ${displayName}, now(), 'active')
  `);
  const created = await db.execute<{ id: string }>(sql`SELECT id FROM users WHERE email = ${email}`);
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

/**
 * A published document with one ready file.
 *
 * Built directly rather than through the upload API so this test does not
 * depend on the chunked-upload flow or on a bucket — and so a failure here
 * points at the content route rather than at the uploader.
 */
async function createDocumentFixture(): Promise<{ documentId: string; fileId: string }> {
  await db.execute(sql`DELETE FROM documents WHERE title = ${DOC_TITLE}`);

  await db.execute(sql`
    INSERT INTO storage_objects (content_hash, bucket, object_key, size_bytes, detected_mime, ref_count)
    VALUES (digest(${DOC_TITLE}, 'sha256'), 'tailieu-documents',
            ${'documents/2026/10/' + '0'.repeat(8) + '-0000-4000-8000-000000000000.pdf'},
            ${PDF_BYTES.length}, 'application/pdf', 1)
    ON CONFLICT (content_hash) DO NOTHING
  `);

  await db.execute(sql`
    INSERT INTO documents (
      title, document_type_id, owner_user_id, faculty_id,
      visibility, status, published_at, language, uploader_confirmed, file_kind
    )
    SELECT ${DOC_TITLE}, dt.id, u.id, f.id,
           'public'::document_visibility, 'published'::document_status, now(), 'vi', true, 'pdf'
      FROM document_types dt, users u, faculties f
     WHERE dt.code = 'lecture' AND u.email = ${SEEDED_STUDENT.email} AND f.code = 'KHTNCN'
     LIMIT 1
  `);

  const document = await db.execute<{ id: string }>(
    sql`SELECT id FROM documents WHERE title = ${DOC_TITLE} ORDER BY created_at DESC LIMIT 1`,
  );
  const id = document.rows[0]!.id;

  await db.execute(sql`
    INSERT INTO document_files (
      document_id, content_hash, original_name, extension, size_bytes,
      declared_mime, detected_mime, file_kind, is_primary, status, preview_status
    )
    SELECT ${id}::uuid, so.content_hash, 'bai-giang-media.pdf', 'pdf', so.size_bytes,
           'application/pdf', 'application/pdf', 'pdf'::file_kind, true, 'ready'::file_status, 'none'::preview_status
      FROM storage_objects so WHERE so.content_hash = digest(${DOC_TITLE}, 'sha256')
  `);

  const file = await db.execute<{ id: string }>(
    sql`SELECT id FROM document_files WHERE document_id = ${id}::uuid LIMIT 1`,
  );

  return { documentId: id, fileId: file.rows[0]!.id };
}

/** Build a multipart body by hand — `app.inject` sends whatever bytes it is given. */
function multipartFile(
  filename: string,
  contentType: string,
  data: Buffer,
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = '----tailieuTestBoundary7f3a';
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`,
      'utf8',
    ),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  ]);

  return {
    payload,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  session = await login(SEEDED_STUDENT.email, SEEDED_STUDENT.password);
  token = session.token;
  const seeded = await db.execute<{ id: string }>(
    sql`SELECT id FROM users WHERE email = ${SEEDED_STUDENT.email}`,
  );
  userId = seeded.rows[0]!.id;

  otherUserId = await createUser(OTHER_EMAIL, 'Người dùng media');
  otherSession = await login(OTHER_EMAIL, OTHER_PASSWORD);
  otherToken = otherSession.token;

  const fixture = await createDocumentFixture();
  documentId = fixture.documentId;
  fileId = fixture.fileId;
});

afterAll(async () => {
  // Restore the real driver before anything else closes, so a later suite in
  // the same process does not inherit the fake.
  setStorage(null);

  await db.execute(sql`DELETE FROM documents WHERE title = ${DOC_TITLE}`);
  await db.execute(sql`DELETE FROM storage_objects WHERE content_hash = digest(${DOC_TITLE}, 'sha256')`);
  await db.execute(sql`DELETE FROM users WHERE email = ${OTHER_EMAIL}`);
  await app.close();
  await closeDatabase();
  await closeRedis();
});

beforeEach(async () => {
  await flushSessionCache();
  await flushPermissionCache();
  installReadableStorage();
});

// =============================================================================

describe('the download URL a client is handed', () => {
  it('is same-origin, not a redirect to the storage host', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/documents/${documentId}/download?fileId=${fileId}`,
      headers: auth(token),
    });

    expect(response.statusCode).toBe(200);
    const data = (response.json() as {
      data: { url: string; expiresInSeconds: number; fileName: string };
    }).data;

    // The regression assertion. A signed URL on the storage origin is what put
    // every preview in a third-party context and made Chrome log the
    // partitioned-cookie warning; nothing may reintroduce one here.
    expect(data.url.startsWith('/api/v1/documents/')).toBe(true);
    expect(data.url).not.toMatch(/^https?:\/\//);
    expect(data.url).not.toContain('X-Amz-Signature');

    // The user's own filename travels in the response, so the save dialog can
    // offer it — the storage key never appears in the URL.
    expect(data.fileName).toBe('bai-giang-media.pdf');
    expect(data.url).not.toContain('bai-giang-media.pdf');
    expect(data.expiresInSeconds).toBeGreaterThan(0);
  });

  it('carries a media token that names this file and this document', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/documents/${documentId}/download?fileId=${fileId}`,
      headers: auth(token),
    });

    const url = (response.json() as { data: { url: string } }).data.url;
    const mediaToken = new URL(url, 'http://localhost').searchParams.get('token');
    expect(mediaToken).toBeTruthy();

    const claims = await verifyMediaToken(mediaToken!);
    expect(claims.fileId).toBe(fileId);
    expect(claims.documentId).toBe(documentId);
  });

  it('refuses a file from a document the viewer may not read', async () => {
    // Private, owned by somebody else.
    await db.execute(sql`
      UPDATE documents SET visibility = 'private'::document_visibility WHERE id = ${documentId}::uuid
    `);

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/documents/${documentId}/download?fileId=${fileId}`,
      headers: auth(otherToken),
    });

    // 404, not 403: confirming that a private document exists is itself a leak.
    expect(response.statusCode).toBe(404);

    await db.execute(sql`
      UPDATE documents SET visibility = 'public'::document_visibility WHERE id = ${documentId}::uuid
    `);
  });
});

describe('the content route', () => {
  /**
   * Mint a URL the way a client does, then hand back its path.
   *
   * The mode matters and is not cosmetic. `preview` and `download` mint the same
   * token against the same bytes and differ only in the `mode` they carry, which
   * the content route turns into `inline` versus `attachment`. Tests that assert
   * on `content-disposition` have to say which of the two they mean.
   */
  async function contentPath(
    as: string,
    mode: 'preview' | 'download' = 'download',
  ): Promise<string> {
    const endpoint = mode === 'preview' ? 'preview' : 'download';
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/documents/${documentId}/${endpoint}?fileId=${fileId}`,
      headers: auth(as),
    });
    return (response.json() as { data: { url: string } }).data.url;
  }

  it('serves the bytes inline with range support, to an unauthenticated caller', async () => {
    // Preview mode: a viewer embeds this URL in an `<object>`, so the file must
    // render in place rather than land in the download tray.
    const path = await contentPath(token, 'preview');
    // No Authorization header, on purpose: this is exactly how the request
    // arrives from an `<object>` or an `<img>`, neither of which can send one.
    // The token in the URL is the whole of the identity here.
    const response = await app.inject({ method: 'GET', url: path });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    // Without this a PDF viewer downloads the whole file before rendering page
    // one, which is the difference between a preview and a stall.
    expect(response.headers['accept-ranges']).toBe('bytes');
    expect(response.headers['content-length']).toBe(String(PDF_BYTES.length));
    // A shared cache must never hold one person's authorized document.
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers['content-disposition']).toContain('inline');
    // The declared type is checked by the browser only if it is told to.
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('hands the same bytes to a download as an attachment under its own name', async () => {
    const path = await contentPath(token, 'download');
    const response = await app.inject({ method: 'GET', url: path });

    expect(response.statusCode).toBe(200);
    // The other half of the mode switch. Same token, same object, and the only
    // difference is that the browser saves this one — under the name the
    // uploader gave it, which is why the name has to survive the round trip
    // through storage that renamed the object to a UUID.
    expect(response.headers['content-disposition']).toContain('attachment');
    expect(response.headers['content-disposition']).toContain('bai-giang-media.pdf');
    expect(response.rawPayload.equals(PDF_BYTES)).toBe(true);
  });

  it('answers a range request with 206 and the right slice', async () => {
    const path = await contentPath(token);
    const response = await app.inject({
      method: 'GET',
      url: path,
      headers: { range: 'bytes=0-7' },
    });

    expect(response.statusCode).toBe(206);
    expect(response.headers['content-range']).toBe(`bytes 0-7/${PDF_BYTES.length}`);
    expect(response.headers['content-length']).toBe('8');
    // The signature of the file, which is what a viewer sniffs first.
    expect(response.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('answers a suffix range, which is how a trailer is read', async () => {
    const path = await contentPath(token);
    const response = await app.inject({
      method: 'GET',
      url: path,
      headers: { range: 'bytes=-6' },
    });

    expect(response.statusCode).toBe(206);
    const start = PDF_BYTES.length - 6;
    expect(response.headers['content-range']).toBe(`bytes ${start}-${PDF_BYTES.length - 1}/${PDF_BYTES.length}`);
    expect(response.rawPayload.toString()).toContain('%%EOF');
  });

  it('answers 416 with the real size when the range is past the end', async () => {
    const path = await contentPath(token);
    const response = await app.inject({
      method: 'GET',
      url: path,
      headers: { range: `bytes=${PDF_BYTES.length + 10}-` },
    });

    expect(response.statusCode).toBe(416);
    // Without `bytes */total` the viewer has no way back: it does not learn the
    // real length from a bare 416 and retries the same impossible range.
    expect(response.headers['content-range']).toBe(`bytes */${PDF_BYTES.length}`);
  });

  it('refuses a request with no token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/documents/${documentId}/files/${fileId}/content`,
    });

    expect(response.statusCode).toBe(403);
    expect((response.json() as { error: { code: string } }).error.code).toBe('MEDIA_TOKEN_INVALID');
  });

  it('refuses a token minted for another file', async () => {
    const path = await contentPath(token);

    // Same document, a different file id. The route checks BOTH halves of the
    // claim; checking only that the token verifies would let someone holding
    // one legitimate link walk the document by editing the path.
    const swapped = path.replace(fileId, UNRELATED_ID);

    const response = await app.inject({ method: 'GET', url: swapped });
    expect(response.statusCode).toBe(403);

    // And the untouched URL still works, so the refusal is about the mismatch
    // rather than about the token having been consumed — a PDF viewer
    // legitimately fetches the same URL many times.
    const good = await app.inject({ method: 'GET', url: path });
    expect(good.statusCode).toBe(200);
  });

  it('refuses an access token presented as a media token', async () => {
    // The audience is what separates the two. Sharing a signing secret is fine;
    // sharing an audience would let a bearer token be replayed from a URL.
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/documents/${documentId}/files/${fileId}/content?token=${token}`,
    });

    expect(response.statusCode).toBe(403);
  });

  it('refuses a file that is not ready', async () => {
    const path = await contentPath(token);

    await db.execute(sql`
      UPDATE document_files SET status = 'pending'::file_status WHERE id = ${fileId}::uuid
    `);

    const response = await app.inject({ method: 'GET', url: path });
    expect(response.statusCode).toBe(404);

    await db.execute(sql`
      UPDATE document_files SET status = 'ready'::file_status WHERE id = ${fileId}::uuid
    `);
  });
});

describe('the public media route', () => {
  // The key shape is `<kind>/<user uuid>/<image uuid>.<ext>` — two UUIDs, so a
  // path cannot be spelled with a traversal segment. Both halves are fixed
  // width hex, which is what makes `..` unspellable rather than merely blocked.
  const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const image = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  it('serves an avatar path immutably', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/media/avatars/${owner}/${image}.png`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/png');
    // Safe to cache forever: every upload writes a fresh UUID, so a changed
    // avatar is a different URL and there is nothing to invalidate.
    expect(response.headers['cache-control']).toContain('immutable');
    expect(response.headers['accept-ranges']).toBe('bytes');
  });

  it('404s anything that is not a profile image path', async () => {
    const rejected = [
      // A document key. The route must never serve one: these paths carry no
      // signature and the route applies no permission check, so a weakness here
      // would hand out every stored document to anyone who could guess a path.
      `documents/2026/10/${image}.pdf`,
      // The right kind with the wrong second segment — a bare key is not a
      // profile path, and accepting one would make the shape meaningless.
      `avatars/${image}.png`,
      `avatars/${owner}/${image}.svg`,
      `avatars/${owner}/${image}.html`,
      `avatars/${owner}/${image}`,
      `covers/${owner}/${image}.png/../../etc/passwd`,
      // Traversal in the segments that are supposed to be UUIDs.
      `avatars/../../documents/2026/10/${image}.pdf`,
      `avatars/${owner}/../${image}.png`,
      `avatars/${owner}/..%2f${image}.png`,
      // Two owners, one image: no shape in this scheme produces that.
      `avatars/${owner}/${owner}/${image}.png`,
    ];

    for (const path of rejected) {
      const response = await app.inject({ method: 'GET', url: `/api/v1/media/${path}` });
      expect(response.statusCode, path).toBe(404);
    }
  });

  it('404s when the object is missing from the bucket', async () => {
    installFakeStorage({ objectSize: async () => null });

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/media/avatars/${owner}/${image}.png`,
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('profile images', () => {
  it('stores an avatar under the owner and returns a same-origin path', async () => {
    installWritableStorage();

    const { payload, headers } = multipartFile('anh-dai-dien.png', 'image/png', PNG_BYTES);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/me/avatar',
      headers: { ...write(session), ...headers },
      payload,
    });

    expect(response.statusCode).toBe(200);

    const data = (response.json() as { data: { avatarUrl: string | null } }).data;
    expect(data.avatarUrl).toMatch(/^\/api\/v1\/media\/avatars\//);
    // Same-origin, so the avatar is not a third-party request and the browser
    // does not partition storage for it.
    expect(data.avatarUrl).not.toMatch(/^https?:\/\//);

    // The key is namespaced per user and carries a fresh UUID, never the name
    // the client sent — the filename is display data, not an address.
    expect(puts).toHaveLength(1);
    expect(puts[0]!.key).toMatch(
      new RegExp(`^avatars/${userId}/[0-9a-f-]{36}\\.png$`),
    );
    expect(puts[0]!.key).not.toContain('anh-dai-dien');
    expect(puts[0]!.contentType).toBe('image/png');

    // The column now points at the stored image.
    const stored = await db.execute<{ avatar_url: string | null }>(
      sql`SELECT avatar_url FROM users WHERE id = ${userId}::uuid`,
    );
    expect(stored.rows[0]!.avatar_url).toBe(data.avatarUrl);
  });

  it('replaces the previous object rather than leaving it behind', async () => {
    installWritableStorage();

    const first = multipartFile('a.png', 'image/png', PNG_BYTES);
    const uploaded = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/me/avatar',
      headers: { ...write(session), ...first.headers },
      payload: first.payload,
    });
    const firstUrl = (uploaded.json() as { data: { avatarUrl: string } }).data.avatarUrl;

    const second = multipartFile('b.png', 'image/png', PNG_BYTES);
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/me/avatar',
      headers: { ...write(session), ...second.headers },
      payload: second.payload,
    });

    // The old object is deleted, and the key deleted is the one the previous
    // upload wrote — a cover can never be used to delete an avatar, or the
    // reverse, because the kind is part of the key.
    const previousKey = firstUrl.replace('/api/v1/media/', '');
    expect(deletes).toContain(previousKey);
  });

  it('refuses a file whose bytes contradict what it claims to be', async () => {
    installWritableStorage();

    // A PDF wearing a .png name and an image/png declaration. An image is the
    // one upload class the browser renders on this origin, so accepting a
    // mislabelled file here is stored XSS, not a formatting quirk.
    const { payload, headers } = multipartFile('gia-mao.png', 'image/png', PDF_BYTES);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/me/avatar',
      headers: { ...write(session), ...headers },
      payload,
    });

    expect(response.statusCode).toBe(415);
    expect(puts).toHaveLength(0);
  });

  it('refuses an SVG, which is markup rather than an image', async () => {
    installWritableStorage();

    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const { payload, headers } = multipartFile('x.svg', 'image/svg+xml', svg);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/me/avatar',
      headers: { ...write(session), ...headers },
      payload,
    });

    expect(response.statusCode).toBe(415);
    expect(puts).toHaveLength(0);
  });

  it('clears the avatar and the stored object', async () => {
    installWritableStorage();

    const upload = multipartFile('a.png', 'image/png', PNG_BYTES);
    const uploaded = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/me/avatar',
      headers: { ...write(session), ...upload.headers },
      payload: upload.payload,
    });
    const storedUrl = (uploaded.json() as { data: { avatarUrl: string } }).data.avatarUrl;

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/v1/auth/me/avatar',
      headers: write(session),
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as { data: { avatarUrl: string | null } }).data.avatarUrl).toBeNull();
    expect(deletes).toContain(storedUrl.replace('/api/v1/media/', ''));
  });

  it('requires authentication', async () => {
    const { payload, headers } = multipartFile('a.png', 'image/png', PNG_BYTES);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/me/avatar',
      headers,
      payload,
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('editing a profile', () => {
  it('updates the fields a person owns', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/auth/me',
      headers: write(otherSession),
      payload: { displayName: 'Tên mới', fullName: 'Nguyễn Văn A', bio: 'Sinh viên CNTT' },
    });

    expect(response.statusCode).toBe(200);
    const data = (response.json() as {
      data: { displayName: string; fullName: string | null; bio: string | null };
    }).data;

    expect(data.displayName).toBe('Tên mới');
    expect(data.fullName).toBe('Nguyễn Văn A');
    expect(data.bio).toBe('Sinh viên CNTT');

    // The write is the source of truth: the response is the same shape the
    // client caches, so no follow-up `/auth/me` is needed to see the change.
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: auth(otherToken) });
    expect((me.json() as { data: { displayName: string } }).data.displayName).toBe('Tên mới');
  });

  it('clears a field with null rather than ignoring it', async () => {
    await app.inject({
      method: 'PATCH',
      url: '/api/v1/auth/me',
      headers: write(otherSession),
      payload: { bio: 'Tạm thời' },
    });

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/auth/me',
      headers: write(otherSession),
      payload: { bio: null },
    });

    // Absent means "leave it", null means "clear it". Collapsing the two would
    // make a field impossible to empty once set.
    expect((response.json() as { data: { bio: string | null } }).data.bio).toBeNull();
  });

  it('refuses a field the person does not own', async () => {
    // `status`, `roles` and `faculty` decide what this account can reach. The
    // schema is `.strict()`, so the guarantee is that the request never parses
    // — not that some later layer remembers to drop the field.
    for (const payload of [
      { displayName: 'Hợp lệ', status: 'suspended' },
      { displayName: 'Hợp lệ', roles: ['admin'] },
      { displayName: 'Hợp lệ', emailVerified: true },
      { displayName: 'Hợp lệ', tokenVersion: 0 },
    ]) {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/v1/auth/me',
        headers: write(otherSession),
        payload,
      });
      // 422, the codebase's status for a body that fails validation, rather
      // than 400. The point is that it never reaches the service at all.
      expect(response.statusCode, JSON.stringify(payload)).toBe(422);
    }

    const row = await db.execute<{ status: string }>(
      sql`SELECT status FROM users WHERE id = ${otherUserId}::uuid`,
    );
    expect(row.rows[0]!.status).toBe('active');
  });

  it('refuses a username somebody else already has', async () => {
    await app.inject({
      method: 'PATCH',
      url: '/api/v1/auth/me',
      headers: write(session),
      payload: { username: 'media-chiem-cho' },
    });

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/auth/me',
      headers: write(otherSession),
      payload: { username: 'media-chiem-cho' },
    });

    expect(response.statusCode).toBe(409);
    expect((response.json() as { error: { code: string } }).error.code).toBe('AUTH_USERNAME_TAKEN');

    // Claiming your own name again is not a conflict with yourself.
    const again = await app.inject({
      method: 'PATCH',
      url: '/api/v1/auth/me',
      headers: write(session),
      payload: { username: 'media-chiem-cho' },
    });
    expect(again.statusCode).toBe(200);

    await db.execute(sql`UPDATE users SET username = NULL WHERE id = ${userId}::uuid`);
  });

  it('refuses a reserved or malformed username', async () => {
    for (const username of ['admin', 'login', 'me', 'ab', 'Có-Dấu', '-bat-dau-bang-gach']) {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/v1/auth/me',
        headers: write(otherSession),
        payload: { username },
      });
      expect(response.statusCode, username).toBe(422);
    }
  });

  it('refuses an empty update', async () => {
    // A request that changes nothing is a client bug, and answering 200 would
    // hide it behind a success. The schema requires at least one key, so this
    // is a validation failure like any other.
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/auth/me',
      headers: write(otherSession),
      payload: {},
    });

    expect(response.statusCode).toBe(422);
  });

  it('requires authentication', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/auth/me',
      payload: { displayName: 'Kẻ lạ' },
    });

    expect(response.statusCode).toBe(401);
  });
});
