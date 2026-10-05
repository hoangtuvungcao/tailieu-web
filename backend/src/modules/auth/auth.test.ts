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
  purgeTestUsers,
  uniqueEmail,
} from '../../test/helpers.js';

/**
 * Authentication integration tests.
 *
 * These drive the real app against a real database. Every one of them
 * corresponds to a bug that was actually found by hand and would have shipped
 * otherwise — in particular the refresh-reuse case, where the revocation was
 * being written inside the transaction that then threw, so it silently rolled
 * back and left the stolen token working.
 */

assertTestDatabase();

let app: FastifyInstance;

interface AuthResponse {
  data: {
    user: { id: string; email: string; roles: string[] };
    accessToken: string;
    expiresIn: number;
  };
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

async function login(email: string, password: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password },
  });
  return {
    status: response.statusCode,
    body: response.json() as AuthResponse & { error?: { code: string } },
    refreshToken: cookieFrom(response.headers, 'rt'),
    csrfToken: cookieFrom(response.headers, 'csrf'),
  };
}

async function refresh(refreshToken: string, csrfToken?: string | null) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/refresh',
    headers: {
      cookie: `rt=${refreshToken}${csrfToken ? `; csrf=${csrfToken}` : ''}`,
      ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
    },
  });
  return {
    status: response.statusCode,
    body: response.json() as AuthResponse & { error?: { code: string } },
    refreshToken: cookieFrom(response.headers, 'rt'),
    csrfToken: cookieFrom(response.headers, 'csrf'),
  };
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await purgeTestUsers();
  await app.close();
  await closeDatabase();
  await closeRedis();
});

beforeEach(async () => {
  await flushSessionCache();
  await flushPermissionCache();
});

describe('login', () => {
  it('issues an access token and both cookies', async () => {
    const result = await login(SEEDED_STUDENT.email, SEEDED_STUDENT.password);

    expect(result.status).toBe(200);
    expect(result.body.data.accessToken).toBeTruthy();
    expect(result.refreshToken).toMatch(/^rt_/);
    expect(result.csrfToken).toBeTruthy();
  });

  it('rejects a wrong password without revealing whether the account exists', async () => {
    const wrongPassword = await login(SEEDED_STUDENT.email, 'definitely-not-the-password');
    const noSuchUser = await login('nobody@tailieu.test', 'definitely-not-the-password');

    expect(wrongPassword.status).toBe(401);
    expect(noSuchUser.status).toBe(401);
    // Identical code and message: anything else is an account-enumeration oracle.
    expect(wrongPassword.body.error?.code).toBe('AUTH_INVALID_CREDENTIALS');
    expect(noSuchUser.body.error?.code).toBe('AUTH_INVALID_CREDENTIALS');
  });
});

describe('access tokens', () => {
  it('accepts a valid token and rejects a missing one', async () => {
    const { body } = await login(SEEDED_STUDENT.email, SEEDED_STUDENT.password);

    const authorised = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${body.data.accessToken}` },
    });
    const anonymous = await app.inject({ method: 'GET', url: '/api/v1/auth/me' });

    expect(authorised.statusCode).toBe(200);
    expect(anonymous.statusCode).toBe(401);
  });

  it('rejects a token signed with the wrong key', async () => {
    // A structurally valid JWT with a valid-looking payload but a bogus
    // signature. The algorithm is pinned during verification, so this must
    // fail rather than being trusted.
    const forged =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
      'eyJzaWQiOiJ4IiwidHYiOjAsInJvbGVzIjpbInN1cGVyX2FkbWluIl0sInN1YiI6ImZha2UiLCJpc3MiOiJ0YWlsaWV1LXR0biIsImF1ZCI6InRhaWxpZXUtdHRuLXdlYiJ9.' +
      'bm90LWEtdmFsaWQtc2lnbmF0dXJl';

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${forged}` },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('refresh rotation', () => {
  it('rotates to a new token and invalidates nothing prematurely', async () => {
    const session = await login(SEEDED_STUDENT.email, SEEDED_STUDENT.password);
    const first = await refresh(session.refreshToken!, session.csrfToken);

    expect(first.status).toBe(200);
    expect(first.refreshToken).toBeTruthy();
    // A rotation that returns the same token would defeat the entire mechanism:
    // a captured token would remain valid forever.
    expect(first.refreshToken).not.toBe(session.refreshToken);
    expect(first.body.data.accessToken).not.toBe(session.body.data.accessToken);
  });

  it('does not re-issue the CSRF cookie on refresh', async () => {
    const session = await login(SEEDED_STUDENT.email, SEEDED_STUDENT.password);
    const rotated = await refresh(session.refreshToken!, session.csrfToken);

    // Rotating it would strand a second browser tab holding the previous
    // value, which then fails the next state-changing request.
    expect(rotated.csrfToken).toBeNull();
  });

  it('treats a benign double refresh as a race, not as theft', async () => {
    const session = await login(SEEDED_STUDENT.email, SEEDED_STUDENT.password);

    const first = await refresh(session.refreshToken!, session.csrfToken);
    const second = await refresh(session.refreshToken!, session.csrfToken);

    expect(first.status).toBe(200);
    // 409 with a retry hint. Returning 401 here would sign out every honest
    // user who happens to have two tabs open.
    expect(second.status).toBe(409);
    expect(second.body.error?.code).toBe('AUTH_REFRESH_RACE');
  });

  it('detects reuse and revokes the whole family, including live tokens', async () => {
    const session = await login(SEEDED_STUDENT.email, SEEDED_STUDENT.password);

    const second = await refresh(session.refreshToken!, session.csrfToken);
    const third = await refresh(second.refreshToken!, session.csrfToken);
    expect(third.status).toBe(200);

    // Replay the FIRST token. Its successor has itself been rotated, so this
    // cannot be a race — it is proof the token was captured.
    const replayed = await refresh(session.refreshToken!, session.csrfToken);
    expect(replayed.status).toBe(401);
    expect(replayed.body.error?.code).toBe('AUTH_REFRESH_REUSE');

    // The stolen-but-live token must be dead...
    const liveToken = await refresh(third.refreshToken!, session.csrfToken);
    expect(liveToken.status).toBe(401);

    // ...and so must the access token, which is the part that is easy to get
    // wrong: revoking refresh tokens alone leaves a 15-minute window in which
    // the attacker's bearer token still works.
    const accessToken = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${third.body.data.accessToken}` },
    });
    expect(accessToken.statusCode).toBe(401);
  });

  it('rejects a malformed or unknown refresh token', async () => {
    const response = await refresh('rt_totally-made-up-token-value', 'csrf-probe-value');

    expect(response.status).toBe(401);
    expect(response.body.error?.code).toBe('AUTH_REFRESH_INVALID');
  });

  it('rejects a token of the wrong type presented as a refresh token', async () => {
    // A password-reset token must never be redeemable as a session credential.
    const response = await refresh('pr_some_password_reset_token', 'csrf-probe-value');

    expect(response.status).toBe(401);
    expect(response.body.error?.code).toBe('AUTH_REFRESH_INVALID');
  });
});

describe('CSRF protection', () => {
  it('rejects a cookie-authenticated mutation with no CSRF header', async () => {
    const session = await login(SEEDED_STUDENT.email, SEEDED_STUDENT.password);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: {
        cookie: `rt=${session.refreshToken}; csrf=${session.csrfToken}`,
        authorization: `Bearer ${session.body.data.accessToken}`,
        // Deliberately no x-csrf-token.
      },
    });

    expect(response.statusCode).toBe(403);
  });

  it('rejects a mismatched CSRF header', async () => {
    const session = await login(SEEDED_STUDENT.email, SEEDED_STUDENT.password);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: {
        cookie: `rt=${session.refreshToken}; csrf=${session.csrfToken}`,
        authorization: `Bearer ${session.body.data.accessToken}`,
        'x-csrf-token': 'a-different-value-entirely',
      },
    });

    expect(response.statusCode).toBe(403);
  });

  it('accepts a matching CSRF header and ends the session', async () => {
    const session = await login(SEEDED_STUDENT.email, SEEDED_STUDENT.password);

    const logout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: {
        cookie: `rt=${session.refreshToken}; csrf=${session.csrfToken}`,
        authorization: `Bearer ${session.body.data.accessToken}`,
        'x-csrf-token': session.csrfToken!,
      },
    });
    expect(logout.statusCode).toBe(200);

    // Signing out must kill the access token, not merely forget the cookie.
    const after = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${session.body.data.accessToken}` },
    });
    expect(after.statusCode).toBe(401);
  });
});

describe('registration', () => {
  it('creates an account with the default role and rejects a duplicate', async () => {
    const email = uniqueEmail('register');

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, password: 'MatKhauRatDai2026', displayName: 'Sinh viên Kiểm thử' },
    });

    expect(created.statusCode).toBe(201);
    expect((created.json() as AuthResponse).data.user.roles).toContain('student');

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, password: 'MatKhauRatDai2026', displayName: 'Trùng lặp' },
    });
    expect(duplicate.statusCode).toBe(409);
  });

  it('rejects a common password', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: uniqueEmail('weak'), password: 'password123', displayName: 'Yếu' },
    });

    expect(response.statusCode).toBe(422);
  });

  it('rejects privilege escalation through an unexpected field', async () => {
    // Mass assignment: the schema is `.strict()`, so an extra key is an error
    // rather than something a downstream layer might honour.
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: uniqueEmail('escalate'),
        password: 'MatKhauRatDai2026',
        displayName: 'Leo thang',
        role: 'super_admin',
      },
    });

    expect(response.statusCode).toBe(422);
  });
});
