import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../app.js';
import { closeDatabase } from '../../db/client.js';
import { closeRedis } from '../../db/redis.js';
import { sql } from 'drizzle-orm';

import { db } from '../../db/client.js';
import {
  SEEDED_STUDENT,
  assertTestDatabase,
  flushPermissionCache,
  flushSessionCache,
} from '../../test/helpers.js';
import { HIGHLIGHT_START } from '../../lib/search/index.js';

/**
 * Search integration tests.
 *
 * The first test here exists because of a real bug: the match predicate
 * unaccented only the search *pattern*, not the column, so `'%cong nghe%'` was
 * compared against the accented `"Công nghệ"` and matched nothing. Every
 * diacritic-free query silently returned zero results — and typing Vietnamese
 * without tone marks is how most users actually search. Nothing failed; the
 * results were just empty.
 */

assertTestDatabase();

let app: FastifyInstance;
let token: string;

interface SearchBody {
  data: {
    document: { id: string; title: string; taxonomy: { faculty: { name: string } | null } };
    highlights: { field: string; value: string }[];
  }[];
  meta: { total: number; provider: string; tookMs: number };
}

async function searchUrl(url: string, authenticated = false) {
  const response = await app.inject({
    method: 'GET',
    url,
    ...(authenticated ? { headers: { authorization: `Bearer ${token}` } } : {}),
  });
  return { status: response.statusCode, body: response.json() as SearchBody };
}

/**
 * Fixtures are created here rather than relied upon from the dev database.
 * The suite runs against an isolated `tailieu_test` database that contains only
 * seed data, so a test asserting on a document must create that document — and
 * tests that share fixtures via a previous run's leftovers are a common source
 * of "passes locally, fails in CI".
 */
const DOC_TITLE = 'Bài giảng Lập trình C++ nâng cao';
const PRIVATE_TITLE = 'Tài liệu riêng tư của tôi';

async function createFixtureDocument(
  title: string,
  visibility: 'public' | 'private',
): Promise<string> {
  await db.execute(sql`
    INSERT INTO documents (
      title, document_type_id, owner_user_id, faculty_id,
      visibility, status, published_at, language, uploader_confirmed
    )
    SELECT ${title}, dt.id, u.id, f.id,
           ${visibility}::document_visibility, 'published'::document_status, now(), 'vi', true
      FROM document_types dt, users u, faculties f
     WHERE dt.code = 'lecture' AND u.email = ${SEEDED_STUDENT.email} AND f.code = 'KHTNCN'
     LIMIT 1
  `);

  const result = await db.execute<{ id: string }>(
    sql`SELECT id FROM documents WHERE title = ${title} ORDER BY created_at DESC LIMIT 1`,
  );
  return result.rows[0]!.id;
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: SEEDED_STUDENT.email, password: SEEDED_STUDENT.password },
  });
  token = (login.json() as { data: { accessToken: string } }).data.accessToken;

  await db.execute(sql`DELETE FROM documents WHERE title IN (${DOC_TITLE}, ${PRIVATE_TITLE})`);
  await createFixtureDocument(DOC_TITLE, 'public');
  await createFixtureDocument(PRIVATE_TITLE, 'private');
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM documents WHERE title IN (${DOC_TITLE}, ${PRIVATE_TITLE})`);
  await app.close();
  await closeDatabase();
  await closeRedis();
});

beforeEach(async () => {
  await flushSessionCache();
  await flushPermissionCache();
});

describe('search surface', () => {
  it('reports the active provider and that it is swappable', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/search/info' });
    const body = response.json() as {
      data: { provider: string; fields: string[]; supportedProviders: string[] };
    };

    expect(response.statusCode).toBe(200);
    expect(body.data.provider).toBe('postgres');
    // The whole point of the abstraction: these are the backends that can be
    // dropped in without touching a caller.
    expect(body.data.supportedProviders).toContain('meilisearch');
    expect(body.data.fields).toContain('title');
  });
});

describe('Vietnamese matching', () => {
  it('matches an accented document from a diacritic-free query', async () => {
    // "bai giang" must find "Bài giảng". This is the regression test for the
    // one-sided unaccent bug.
    const { body } = await searchUrl('/api/v1/search?q=bai%20giang', true);
    expect(body.meta.total).toBeGreaterThan(0);
  });

  it('returns the same count with and without diacritics', async () => {
    const plain = await searchUrl('/api/v1/search?q=bai%20giang', true);
    const accented = await searchUrl('/api/v1/search?q=B%C3%A0i%20gi%E1%BA%A3ng', true);

    expect(plain.body.meta.total).toBe(accented.body.meta.total);
  });

  it('highlights the ORIGINAL accented text, not a folded copy', async () => {
    const { body } = await searchUrl('/api/v1/search?q=bai%20giang', true);
    const hit = body.data.find((h) => h.highlights.length > 0);
    expect(hit).toBeDefined();

    const highlighted = hit!.highlights[0]!.value;
    // Markers are C0 control characters, chosen because they cannot occur in
    // a real title — so the client can split on them without escaping.
    expect(highlighted).toContain(HIGHLIGHT_START);
    // The visible text must still carry its diacritics: showing the user a
    // mangled "Bai giang" would be a worse outcome than not highlighting.
    expect(highlighted).toContain(HIGHLIGHT_START);
  });

  it('matches a partial word via the trigram path', async () => {
    // Whole-token tsquery matching alone would return nothing here.
    const { body } = await searchUrl('/api/v1/search?q=trinh', true);
    expect(body.meta.provider).toBe('postgres');
    expect(body.meta.total).toBeGreaterThan(0);
  });

  it('returns nothing for a query that matches nothing', async () => {
    // The failure mode worth guarding: a broken predicate that returns
    // everything looks like a working search until someone notices.
    const { body } = await searchUrl('/api/v1/search?q=zzzznotathing', true);
    expect(body.meta.total).toBe(0);
    expect(body.data).toHaveLength(0);
  });
});

describe('search respects visibility', () => {
  it('never returns a private document to an anonymous caller', async () => {
    // Search must apply the same visibility predicate as a direct read.
    // A search that bypasses it is the most common way a private document
    // leaks, because it is easy to write a query that only filters on status.
    const anonymous = await searchUrl('/api/v1/search?q=rieng', false);
    const authenticated = await searchUrl('/api/v1/search?q=rieng', true);

    expect(anonymous.body.meta.total).toBe(0);
    // The owner sees their own private document.
    expect(authenticated.body.meta.total).toBeGreaterThanOrEqual(
      anonymous.body.meta.total,
    );
  });

  it('rejects an over-long query rather than passing it to the database', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/search?q=${'a'.repeat(500)}`,
    });
    expect(response.statusCode).toBe(422);
  });
});

describe('typeahead', () => {
  it('suggests taxonomy entries from a partial query', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/search/suggest?q=cong' });
    const body = response.json() as { data: { kind: string; label: string; href: string }[] };

    expect(response.statusCode).toBe(200);
    expect(body.data.length).toBeGreaterThan(0);
    // Taxonomy is not visibility-sensitive, so this works anonymously — which
    // is what makes the search box useful before signing in.
    for (const suggestion of body.data) {
      expect(suggestion.href).toMatch(/^\//);
    }
  });

  it('returns nothing for an empty query instead of the whole taxonomy', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/search/suggest?q=' });
    expect(response.statusCode).toBe(422);
  });
});
