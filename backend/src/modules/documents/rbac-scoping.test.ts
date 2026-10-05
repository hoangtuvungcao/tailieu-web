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
 * Faculty-scoped moderation.
 *
 * This suite exists because the scoping claim was, until now, unverified. The
 * `faculty_moderator` role is the only place in the system where a permission
 * is granted *conditionally on a row's faculty*, and that condition lives in
 * SQL — `visibilityPredicate` and `listModerationQueue` both narrow by
 * `facultyIds`. A regression there would not fail any other test: a scoped
 * moderator would simply be able to moderate every faculty, which looks like
 * the feature working.
 *
 * Two independent things are asserted, and both matter:
 *
 *   1. READS are scoped. A moderator for faculty A cannot see faculty B's
 *      unpublished documents at all — the rows are never loaded.
 *   2. WRITES are scoped. Even knowing a document's id, they cannot moderate it.
 *
 * A system that got (1) right and (2) wrong would look fine while browsing and
 * be trivially exploitable by anyone who guessed a UUID.
 */

assertTestDatabase();

let app: FastifyInstance;
let adminToken: string;
let globalModeratorToken: string;
let scopedModeratorToken: string;

let facultyA: string;
let facultyB: string;
let pendingDocumentA: string;
let pendingDocumentB: string;

const SCOPED_EMAIL = 'scoped-mod@tailieu.test';

async function login(email: string, password: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password },
  });
  const body = response.json() as { data?: { accessToken: string }; error?: unknown };
  if (!body.data) throw new Error(`login failed for ${email}: ${JSON.stringify(body.error)}`);
  return body.data.accessToken;
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

/** Create a document that is unpublished, so only moderators can reach it. */
async function createPendingDocument(facultyId: string, title: string): Promise<string> {
  await db.execute(sql`
    INSERT INTO documents (
      title, document_type_id, owner_user_id, faculty_id,
      visibility, status, language, uploader_confirmed
    )
    SELECT ${title}, dt.id, u.id, ${facultyId}::uuid,
           'internal'::document_visibility, 'pending_review'::document_status, 'vi', true
      FROM document_types dt, users u
     WHERE dt.code = 'lecture' AND u.email = ${SEEDED_STUDENT.email}
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

  adminToken = await login(
    'admin@tailieu.local',
    process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMe_Admin_2026',
  );
  globalModeratorToken = await login(
    'moderator@tailieu.local',
    process.env.SEED_MODERATOR_PASSWORD ?? 'ChangeMe_Mod_2026',
  );

  const faculties = await db.execute<{ id: string; code: string }>(
    sql`SELECT id, code FROM faculties WHERE code IN ('KHTNCN', 'YD')`,
  );
  facultyA = faculties.rows.find((f) => f.code === 'KHTNCN')!.id;
  facultyB = faculties.rows.find((f) => f.code === 'YD')!.id;

  // --- A faculty moderator scoped to faculty A only ------------------------
  await db.execute(sql`DELETE FROM users WHERE email = ${SCOPED_EMAIL}`);
  const passwordHash = await hashPassword('ScopedMod_2026!');

  await db.execute(sql`
    INSERT INTO users (email, display_name, email_verified_at, status)
    VALUES (${SCOPED_EMAIL}, 'Kiểm duyệt viên khoa A', now(), 'active')
  `);

  const scopedUser = await db.execute<{ id: string }>(
    sql`SELECT id FROM users WHERE email = ${SCOPED_EMAIL}`,
  );
  const scopedUserId = scopedUser.rows[0]!.id;

  await db.execute(sql`
    INSERT INTO auth_identities (user_id, provider, provider_uid, password_hash)
    VALUES (${scopedUserId}::uuid, 'password', ${SCOPED_EMAIL}, ${passwordHash})
  `);

  // The grant that matters: faculty_moderator WITH a faculty_id. The same role
  // granted with a NULL faculty would be a global grant, which is the
  // distinction this whole suite is about.
  await db.execute(sql`
    INSERT INTO user_roles (user_id, role_id, faculty_id)
    SELECT ${scopedUserId}::uuid, r.id, ${facultyA}::uuid
      FROM roles r WHERE r.key = 'faculty_moderator'
  `);

  await db.execute(sql`DELETE FROM documents WHERE title LIKE 'RBAC-%'`);
  pendingDocumentA = await createPendingDocument(facultyA, 'RBAC- khoa A');
  pendingDocumentB = await createPendingDocument(facultyB, 'RBAC- khoa B');

  scopedModeratorToken = await login(SCOPED_EMAIL, 'ScopedMod_2026!');
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM documents WHERE title LIKE 'RBAC-%'`);
  await db.execute(sql`DELETE FROM users WHERE email = ${SCOPED_EMAIL}`);
  await app.close();
  await closeDatabase();
  await closeRedis();
});

beforeEach(async () => {
  await flushSessionCache();
  await flushPermissionCache();
});

describe('a scoped faculty moderator', () => {
  it('can read an unpublished document in their own faculty', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/documents/${pendingDocumentA}`,
      headers: auth(scopedModeratorToken),
    });

    expect(response.statusCode).toBe(200);
  });

  it('cannot read an unpublished document in another faculty', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/documents/${pendingDocumentB}`,
      headers: auth(scopedModeratorToken),
    });

    // 404, not 403. A 403 would confirm the document exists, which is itself
    // a disclosure — the id is the only thing an attacker has.
    expect(response.statusCode).toBe(404);
  });

  it('cannot moderate a document in another faculty, even knowing its id', async () => {
    // This is the assertion that matters most. Read-scoping alone is not
    // security: without a write check, anyone who learned a UUID could
    // publish or archive another faculty's document.
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/documents/${pendingDocumentB}/moderate`,
      headers: auth(scopedModeratorToken),
      payload: { action: 'publish', reason: 'attempted cross-faculty moderation' },
    });

    expect(response.statusCode).toBe(403);

    // And the document must be untouched.
    const after = await db.execute<{ status: string }>(
      sql`SELECT status::text FROM documents WHERE id = ${pendingDocumentB}`,
    );
    expect(after.rows[0]!.status).toBe('pending_review');
  });

  it('can moderate a document in their own faculty', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/documents/${pendingDocumentA}/moderate`,
      headers: auth(scopedModeratorToken),
      payload: { action: 'publish', reason: 'reviewed and approved' },
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as { data: { status: string } }).data.status).toBe('published');
  });
});

describe('a global moderator', () => {
  it('sees documents in every faculty', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/documents/${pendingDocumentB}`,
      headers: auth(globalModeratorToken),
    });

    // The contrast with the scoped moderator above is the point: same role
    // name, different grant shape, different reach.
    expect(response.statusCode).toBe(200);
  });

  it('can moderate a document in any faculty', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/documents/${pendingDocumentB}/moderate`,
      headers: auth(globalModeratorToken),
      payload: { action: 'publish', reason: 'global moderator review' },
    });

    expect(response.statusCode).toBe(200);
  });
});

describe('the moderation queue', () => {
  it('shows a scoped moderator only their own faculty', async () => {
    // Creates its own fixtures: earlier tests publish the shared documents, so
    // the queue is legitimately empty by the time this runs. Asserting on
    // whatever happens to be left is how a test becomes order-dependent.
    const freshA = await createPendingDocument(facultyA, 'RBAC- queue khoa A');
    const freshB = await createPendingDocument(facultyB, 'RBAC- queue khoa B');
    expect(freshA).toBeTruthy();
    expect(freshB).toBeTruthy();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/documents/moderation/queue?limit=100',
      headers: auth(scopedModeratorToken),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { data: { taxonomy: { faculty: { id: string } | null } }[] };

    expect(body.data.length).toBeGreaterThan(0);
    for (const document of body.data) {
      // Every row must belong to the faculty they moderate. A single foreign
      // row here is the leak — the queue is how a moderator discovers work.
      expect(document.taxonomy.faculty?.id).toBe(facultyA);
    }
  });

  it('refuses a plain student entirely', async () => {
    const studentToken = await login(SEEDED_STUDENT.email, SEEDED_STUDENT.password);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/documents/moderation/queue',
      headers: auth(studentToken),
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('an administrator', () => {
  it('outranks faculty scoping', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/documents/${pendingDocumentA}`,
      headers: auth(adminToken),
    });

    expect(response.statusCode).toBe(200);
  });
});
