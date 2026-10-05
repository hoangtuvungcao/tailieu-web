import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../app.js';
import { closeDatabase } from '../../db/client.js';
import { closeRedis } from '../../db/redis.js';
import {
  SEEDED_STUDENT,
  assertTestDatabase,
  flushPermissionCache,
  flushSessionCache,
} from '../../test/helpers.js';

/**
 * Taxonomy integration tests.
 *
 * Two things are being protected here:
 *
 *   1. Vietnamese search. Postgres has no Vietnamese stemmer, so the naive
 *      `to_tsvector('english', ...)` returns nothing useful and even a plain
 *      ILIKE fails to match "cong nghe" against "Công nghệ". These tests pin the
 *      unaccent behaviour so a future refactor cannot quietly break it.
 *
 *   2. Permission granularity. A moderator holds real moderation powers, and it
 *      would be easy to conflate that with administrative power. These tests
 *      assert that moderation rights do NOT confer taxonomy-management rights.
 */

assertTestDatabase();

let app: FastifyInstance;
let adminToken: string;
let moderatorToken: string;
let studentToken: string;

async function login(email: string, password: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password },
  });
  return (response.json() as { data: { accessToken: string } }).data.accessToken;
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  adminToken = await login('admin@tailieu.local', process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMe_Admin_2026');
  moderatorToken = await login(
    'moderator@tailieu.local',
    process.env.SEED_MODERATOR_PASSWORD ?? 'ChangeMe_Mod_2026',
  );
  studentToken = await login(SEEDED_STUDENT.email, SEEDED_STUDENT.password);
});

afterAll(async () => {
  await app.close();
  await closeDatabase();
  await closeRedis();
});

beforeEach(async () => {
  await flushSessionCache();
  await flushPermissionCache();
});

describe('public reads', () => {
  it('returns the whole taxonomy tree without authentication', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/taxonomy/tree' });
    const body = response.json() as {
      data: { code: string; programs: unknown[] }[];
    };

    expect(response.statusCode).toBe(200);
    expect(body.data).toHaveLength(7);
    // The 2026 structure: 7 faculties, 37 undergraduate programs.
    expect(body.data.reduce((sum, f) => sum + f.programs.length, 0)).toBe(37);
  });
});

describe('Vietnamese-aware search', () => {
  it('matches accented names from an unaccented query', async () => {
    // The case that would silently return nothing with the default text search
    // configuration: no diacritics in the query, diacritics in the data.
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/taxonomy/programs?q=cong nghe',
    });
    const body = response.json() as { data: { name: string }[]; meta: { total: number } };

    expect(response.statusCode).toBe(200);
    expect(body.meta.total).toBeGreaterThan(0);
    for (const program of body.data) {
      expect(program.name).toContain('Công nghệ');
    }
  });

  it('returns the same results whether or not the query has diacritics', async () => {
    const plain = await app.inject({ method: 'GET', url: '/api/v1/taxonomy/programs?q=cong nghe' });
    const accented = await app.inject({
      method: 'GET',
      url: '/api/v1/taxonomy/programs?q=Công nghệ',
    });

    expect((plain.json() as { meta: { total: number } }).meta.total).toBe(
      (accented.json() as { meta: { total: number } }).meta.total,
    );
  });

  it('matches a partial word', async () => {
    // Rescued by the trigram index, not the tsvector — this is the query shape
    // students actually type while searching.
    const response = await app.inject({ method: 'GET', url: '/api/v1/taxonomy/programs?q=nghe' });
    expect((response.json() as { meta: { total: number } }).meta.total).toBeGreaterThan(0);
  });

  it('filters programs by faculty', async () => {
    const faculties = await app.inject({ method: 'GET', url: '/api/v1/taxonomy/faculties?q=Kinh tế' });
    const facultyId = (faculties.json() as { data: { id: string }[] }).data[0]!.id;

    const programs = await app.inject({
      method: 'GET',
      url: `/api/v1/taxonomy/programs?facultyId=${facultyId}&limit=100`,
    });

    // Faculty of Economics has 8 programs in the 2026 structure.
    expect((programs.json() as { meta: { total: number } }).meta.total).toBe(8);
  });
});

describe('pagination', () => {
  it('reports counts and page flags', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/taxonomy/programs?limit=5&page=2' });
    const body = response.json() as {
      data: unknown[];
      meta: { page: number; total: number; totalPages: number; hasNext: boolean; hasPrev: boolean };
    };

    expect(body.data).toHaveLength(5);
    expect(body.meta.page).toBe(2);
    expect(body.meta.total).toBe(37);
    expect(body.meta.totalPages).toBe(8);
    expect(body.meta.hasNext).toBe(true);
    expect(body.meta.hasPrev).toBe(true);
  });

  it('rejects a limit above the cap instead of trying to serve it', async () => {
    // Uncapped, `?limit=1000000` is a cheap way to exhaust memory or dump the
    // table in one request.
    const response = await app.inject({ method: 'GET', url: '/api/v1/taxonomy/programs?limit=9999' });

    expect(response.statusCode).toBe(422);
  });
});

describe('permission granularity', () => {
  const newFaculty = { code: 'ZZTEST', name: 'Khoa Kiểm thử' };

  it('rejects anonymous writes', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/taxonomy/faculties',
      payload: newFaculty,
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a student', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/taxonomy/faculties',
      headers: auth(studentToken),
      payload: newFaculty,
    });

    expect(response.statusCode).toBe(403);
    expect((response.json() as { error: { code: string } }).error.code).toBe('PERMISSION_DENIED');
  });

  it('rejects a moderator — moderation rights are not administrative rights', async () => {
    // The permission model is namespaced precisely so these stay separate.
    const faculty = await app.inject({
      method: 'POST',
      url: '/api/v1/taxonomy/faculties',
      headers: auth(moderatorToken),
      payload: newFaculty,
    });
    const subject = await app.inject({
      method: 'POST',
      url: '/api/v1/taxonomy/subjects',
      headers: auth(moderatorToken),
      payload: { code: 'ZZ101', name: 'Môn kiểm thử' },
    });

    expect(faculty.statusCode).toBe(403);
    expect(subject.statusCode).toBe(403);
  });

  it('allows an administrator to create, then rejects a duplicate code', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/taxonomy/faculties',
      headers: auth(adminToken),
      payload: newFaculty,
    });
    expect(created.statusCode).toBe(201);

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/v1/taxonomy/faculties',
      headers: auth(adminToken),
      payload: { code: 'ZZTEST', name: 'Trùng mã' },
    });
    expect(duplicate.statusCode).toBe(409);

    // Clean up through the API so the deletion path is exercised too.
    const facultyId = (created.json() as { data: { id: string } }).data.id;
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/taxonomy/faculties/${facultyId}`,
      headers: auth(adminToken),
    });
    expect(deleted.statusCode).toBe(200);
  });

  it('refuses to delete a faculty that still has programs', async () => {
    const faculties = await app.inject({
      method: 'GET',
      url: '/api/v1/taxonomy/faculties?q=Kinh tế',
    });
    const facultyId = (faculties.json() as { data: { id: string }[] }).data[0]!.id;

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/taxonomy/faculties/${facultyId}`,
      headers: auth(adminToken),
    });

    // 409 with a reason, not a raw foreign-key violation: the database would
    // refuse anyway, but "violates foreign key constraint" tells an
    // administrator nothing about what to do next.
    expect(response.statusCode).toBe(409);
    expect((response.json() as { error: { code: string } }).error.code).toBe('FACULTY_IN_USE');
  });
});
