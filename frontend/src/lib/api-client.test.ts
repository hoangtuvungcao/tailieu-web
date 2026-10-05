import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ApiError,
  api,
  apiRequest,
  onAuthenticationLost,
  refreshSession,
  setAccessToken,
} from './api-client';

/**
 * API client tests.
 *
 * The most important test in this file is the single-flight one. The refresh
 * token rotates, so each successful refresh invalidates the previous token. If
 * five components mount at once and each starts its own refresh, four of them
 * present a token that was just rotated — which the server correctly reads as
 * **token theft** and responds to by revoking the entire session family. The
 * user gets signed out.
 *
 * That failure looks like a backend bug and is caused entirely by the client.
 * So it is asserted directly.
 */

const originalFetch = globalThis.fetch;

interface RecordedCall {
  url: string;
  init: RequestInit;
}

let calls: RecordedCall[] = [];

/** Queue a response, recording the request that produced it. */
function respondWith(
  body: unknown,
  options: { status?: number; headers?: Record<string, string> } = {},
): void {
  const status = options.status ?? 200;
  vi.mocked(globalThis.fetch).mockImplementationOnce(async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
    });
  });
}

function ok<T>(data: T, meta: Record<string, unknown> = {}) {
  return { success: true, data, message: null, meta };
}

function fail(code: string, message = 'failed', status = 400) {
  return { body: { success: false, error: { code, message } }, status };
}

/**
 * Establish the cookie the client reads to decide whether it has a session.
 *
 * `refreshSession` does not ask the server when this cookie is absent, since
 * that request could only ever be refused — see the test that pins that
 * behaviour. So every test exercising a refresh has to look signed in first,
 * exactly as a browser would after signing in.
 */
function signIn() {
  document.cookie = 'csrf=csrf-value-123; path=/';
}

beforeEach(() => {
  calls = [];
  globalThis.fetch = vi.fn();
  setAccessToken(null);
  // Clear cookies between tests; jsdom persists them on the document.
  for (const cookie of document.cookie.split(';')) {
    const name = cookie.split('=')[0]?.trim();
    if (name) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  }
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('request shape', () => {
  it('sends the access token as a bearer header when present', async () => {
    setAccessToken('token-abc');
    respondWith(ok({ id: '1' }));

    await api.get('/documents');

    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get('authorization')).toBe('Bearer token-abc');
  });

  it('omits the authorization header when signed out', async () => {
    respondWith(ok({ id: '1' }));

    await api.get('/documents');

    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get('authorization')).toBeNull();
  });

  it('always sends credentials, or the refresh cookie never travels', async () => {
    respondWith(ok({}));
    await api.get('/documents');

    // Without this the browser omits cookies on cross-origin requests and every
    // session dies on the first page reload.
    expect(calls[0]!.init.credentials).toBe('include');
  });

  it('attaches the CSRF header on mutating requests', async () => {
    document.cookie = 'csrf=csrf-value-123; path=/';
    respondWith(ok({}));

    await api.post('/documents', { title: 'x' });

    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get('x-csrf-token')).toBe('csrf-value-123');
  });

  it('does NOT attach the CSRF header on GET', async () => {
    document.cookie = 'csrf=csrf-value-123; path=/';
    respondWith(ok({}));

    await api.get('/documents');

    // Reads carry no ambient authority, so CSRF does not apply — and sending it
    // would break the moment the cookie expires while reads should still work.
    expect(new Headers(calls[0]!.init.headers).get('x-csrf-token')).toBeNull();
  });
});

describe('response envelope', () => {
  it('unwraps a successful envelope', async () => {
    respondWith(ok({ id: 'doc-1', title: 'Bài giảng' }));

    const result = await api.get<{ id: string; title: string }>('/documents/doc-1');

    expect(result).toEqual({ id: 'doc-1', title: 'Bài giảng' });
  });

  it('throws ApiError carrying the machine-readable code', async () => {
    respondWith(fail('DOCUMENT_NOT_FOUND', 'Không tìm thấy tài liệu.', 404).body, { status: 404 });

    await expect(api.get('/documents/nope')).rejects.toMatchObject({
      code: 'DOCUMENT_NOT_FOUND',
      status: 404,
    });
  });

  it('exposes field-level validation errors for form rendering', async () => {
    respondWith(
      {
        success: false,
        error: {
          code: 'VALIDATION_FAILED',
          message: 'invalid',
          details: { fields: { password: ['Mật khẩu phải có ít nhất 10 ký tự.'] } },
        },
      },
      { status: 422 },
    );

    try {
      await api.post('/auth/register', {});
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).fieldErrors.password?.[0]).toContain('10 ký tự');
    }
  });

  it('reports a non-JSON body rather than crashing on parse', async () => {
    // A proxy or tunnel can return HTML where JSON was expected. Throwing from
    // inside JSON.parse would surface as an unhandled error rather than a
    // usable message.
    respondWith('<html>502 Bad Gateway</html>', { status: 502 });

    await expect(api.get('/documents')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});

describe('single-flight refresh', () => {
  it('does not ask the server when there is no session cookie', async () => {
    // The bootstrap runs on every page load for every visitor. Asking anyway
    // means an anonymous visitor — and on a public document library that is
    // most of them, crawlers included — makes a request that can only be
    // refused, and the browser logs that failure in the console on every page.
    respondWith(ok({ accessToken: 'unused' }));

    await expect(refreshSession()).resolves.toBe(false);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('collapses concurrent refreshes into ONE request', async () => {
    // THE critical assertion. Five simultaneous callers must produce one
    // refresh. Five refreshes would present four already-rotated tokens, which
    // the server reads as theft and answers by revoking the whole family —
    // signing the user out through no fault of the backend.
    signIn();
    let resolveRefresh: ((value: Response) => void) | undefined;

    vi.mocked(globalThis.fetch).mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveRefresh = resolve;
        }),
    );

    const inflight = Promise.all([
      refreshSession(),
      refreshSession(),
      refreshSession(),
      refreshSession(),
      refreshSession(),
    ]);

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    resolveRefresh?.(
      new Response(JSON.stringify(ok({ accessToken: 'fresh-token' })), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const results = await inflight;
    expect(results).toEqual([true, true, true, true, true]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('allows a new refresh after the previous one settles', async () => {
    signIn();
    respondWith(ok({ accessToken: 'first' }));
    expect(await refreshSession()).toBe(true);

    respondWith(ok({ accessToken: 'second' }));
    expect(await refreshSession()).toBe(true);

    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('returns false rather than throwing when the refresh is rejected', async () => {
    // Callers need a boolean to decide whether to retry. An exception here
    // would surface as an unhandled rejection in whichever component lost the
    // race.
    signIn();
    respondWith(fail('AUTH_REFRESH_EXPIRED', 'expired', 401).body, { status: 401 });

    await expect(refreshSession()).resolves.toBe(false);
  });

  it('retries once on a 409 race and then succeeds', async () => {
    // Two tabs refreshing at once. The server says "retry" rather than "you
    // are a thief", and the retry carries the successor cookie the other tab
    // already stored.
    signIn();
    respondWith(fail('AUTH_REFRESH_RACE', 'race', 409).body, { status: 409 });
    respondWith(ok({ accessToken: 'after-race' }));

    await expect(refreshSession()).resolves.toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
});

describe('automatic retry after expiry', () => {
  it('refreshes and replays the request on a 401', async () => {
    signIn();
    setAccessToken('stale');
    respondWith(fail('AUTH_TOKEN_EXPIRED', 'expired', 401).body, { status: 401 }); // original
    respondWith(ok({ accessToken: 'fresh' })); // refresh
    respondWith(ok({ id: 'doc-1' })); // replay

    const result = await api.get<{ id: string }>('/documents/doc-1');

    expect(result).toEqual({ id: 'doc-1' });
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });

  it('does not loop when the replay also fails', async () => {
    signIn();
    setAccessToken('stale');
    respondWith(fail('AUTH_TOKEN_EXPIRED', 'expired', 401).body, { status: 401 }); // original
    respondWith(ok({ accessToken: 'fresh' })); // refresh succeeds
    respondWith(fail('AUTH_TOKEN_EXPIRED', 'expired', 401).body, { status: 401 }); // replay fails

    await expect(api.get('/documents')).rejects.toMatchObject({ code: 'AUTH_TOKEN_EXPIRED' });
    // Exactly one retry. A loop here would hammer the API on every request.
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });

  it('notifies the app when the session is revoked', async () => {
    signIn();
    setAccessToken('stale');
    const lost = vi.fn();
    onAuthenticationLost(lost);

    respondWith(fail('AUTH_SESSION_REVOKED', 'revoked', 401).body, { status: 401 });
    respondWith(fail('AUTH_SESSION_REVOKED', 'revoked', 401).body, { status: 401 });

    await expect(api.get('/documents')).rejects.toBeInstanceOf(ApiError);

    // The UI must be told, or it keeps rendering a signed-in shell over a dead
    // session and every action fails silently.
    expect(lost).toHaveBeenCalled();
  });
});

describe('skipAuthRetry', () => {
  it('does not attempt a refresh when the caller opts out', async () => {
    respondWith(fail('AUTH_INVALID_CREDENTIALS', 'wrong password', 401).body, { status: 401 });

    await expect(
      apiRequest('/auth/login', { method: 'POST', body: {}, skipAuthRetry: true }),
    ).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });

    // A failed login must not trigger a refresh — there is no session to
    // refresh, and doing so would add a pointless round trip to every typo.
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});
