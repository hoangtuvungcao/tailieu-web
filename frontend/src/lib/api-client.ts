/**
 * API client.
 *
 * Three decisions here are load-bearing, and getting any of them wrong breaks
 * authentication in a way that only shows up under real usage:
 *
 * 1. THE ACCESS TOKEN LIVES IN MEMORY ONLY — never localStorage, never a
 *    cookie. localStorage is readable by any script on the origin, so one XSS
 *    means a stolen session. A cookie would be sent automatically by the
 *    browser, which is what makes CSRF possible in the first place.
 *
 * 2. REFRESH IS SINGLE-FLIGHT. The refresh token rotates: each successful
 *    refresh invalidates the previous token. If five components mount at once
 *    and each triggers a refresh, four of them present a token that was just
 *    rotated — which the server correctly interprets as theft and responds to
 *    by revoking the entire session family. So all callers share one promise.
 *
 * 3. THE CSRF TOKEN IS READ FROM ITS COOKIE per request. It is deliberately not
 *    httpOnly, because the double-submit pattern requires JavaScript to echo it
 *    back in a header. It carries no authority on its own; it only proves the
 *    request came from a page that could read this origin's cookies.
 */

const API_BASE = import.meta.env.VITE_API_URL ?? '/api/v1';

export interface ApiEnvelope<T> {
  success: true;
  data: T;
  message: string | null;
  meta: Record<string, unknown>;
}

export interface ApiErrorBody {
  success: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Field-level validation errors, for rendering next to form inputs. */
  get fieldErrors(): Record<string, string[]> {
    const fields = this.details?.fields;
    return fields && typeof fields === 'object' ? (fields as Record<string, string[]>) : {};
  }

  /** True when re-authenticating would plausibly help. */
  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

// --- Token state -------------------------------------------------------------

let accessToken: string | null = null;
let refreshPromise: Promise<boolean> | null = null;
let onSessionLost: (() => void) | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

/** Registered by the auth provider so a dead session can clear UI state. */
export function onAuthenticationLost(handler: () => void): void {
  onSessionLost = handler;
}

function readCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

// --- Core request ------------------------------------------------------------

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** Skip the automatic refresh-and-retry. Used by the auth endpoints. */
  skipAuthRetry?: boolean;
}

async function rawRequest(path: string, options: RequestOptions): Promise<Response> {
  const method = (options.method ?? 'GET').toUpperCase();
  const headers = new Headers(options.headers);

  if (options.body !== undefined && !(options.body instanceof FormData)) {
    headers.set('content-type', 'application/json');
  }

  if (accessToken) {
    headers.set('authorization', `Bearer ${accessToken}`);
  }

  // Only state-changing methods need CSRF protection. Sending it on GETs would
  // be harmless but noisy, and would break the moment the cookie expires while
  // reads should still work.
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const csrf = readCookie('csrf');
    if (csrf) headers.set('x-csrf-token', csrf);
  }

  return fetch(`${API_BASE}${path}`, {
    ...options,
    method,
    headers,
    // Required for the refresh cookie to be sent. Without it the browser
    // omits cookies on cross-origin requests and every session dies on reload.
    credentials: 'include',
    body:
      options.body === undefined
        ? undefined
        : options.body instanceof FormData
          ? options.body
          : JSON.stringify(options.body),
  });
}

/**
 * Perform the refresh exchange itself.
 *
 * Deliberately NOT the exported `refreshSession`. Retrying the 409 race by
 * calling `refreshSession()` recursively would re-enter the single-flight
 * wrapper *while its own promise is still assigned* — so the retry would await
 * the very promise it is running inside, and the refresh would hang forever.
 * The wrapper collapses concurrent callers; the work inside it must not.
 */
async function performRefresh(attempt = 0): Promise<boolean> {
  try {
    const response = await rawRequest('/auth/refresh', {
      method: 'POST',
      skipAuthRetry: true,
    });

    if (response.status === 409) {
      // A benign race: another tab refreshed a moment ago and the successor
      // cookie is already set. Retry — but only a bounded number of times, so
      // a server that answers 409 persistently cannot spin this into a loop.
      if (attempt >= 2) return false;
      await new Promise((resolve) => setTimeout(resolve, 150));
      return performRefresh(attempt + 1);
    }

    if (!response.ok) return false;

    const body = (await response.json()) as ApiEnvelope<{ accessToken: string }>;
    accessToken = body.data.accessToken;
    return true;
  } catch {
    return false;
  }
}

/**
 * Refresh the access token, collapsing concurrent callers into one request.
 *
 * Returns true on success. Never throws: callers need a boolean to decide
 * whether to retry, and an exception here would surface as an unhandled
 * rejection in whichever component happened to lose the race.
 */
export function refreshSession(): Promise<boolean> {
  refreshPromise ??= performRefresh().finally(() => {
    // Cleared after the promise settles. Assigning inside the async body
    // instead would let a caller that resolves in the same tick observe the
    // stale promise and skip its own refresh.
    refreshPromise = null;
  });

  return refreshPromise;
}

/** Clear local session state and notify the UI. */
function loseSession(): void {
  accessToken = null;
  onSessionLost?.();
}

/**
 * Perform an API request, refreshing once and retrying on 401.
 *
 * The retry is what makes a 15-minute access token invisible to the user: a
 * request made just after expiry fails, silently refreshes, and succeeds — with
 * the caller never seeing the 401.
 */
export async function apiRequest<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  let response = await rawRequest(path, options);

  if (response.status === 401 && !options.skipAuthRetry) {
    const refreshed = await refreshSession();

    if (refreshed) {
      response = await rawRequest(path, { ...options, skipAuthRetry: true });
    } else {
      loseSession();
    }
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // A non-JSON body from an API that always returns JSON means something
    // upstream — a proxy, a tunnel — produced it.
    throw new ApiError(
      'INVALID_RESPONSE',
      'Máy chủ trả về dữ liệu không hợp lệ.',
      response.status,
    );
  }

  if (!response.ok) {
    const body = parsed as ApiErrorBody | null;
    const code = body?.error?.code ?? 'UNKNOWN_ERROR';
    const message = body?.error?.message ?? 'Đã xảy ra lỗi không xác định.';

    // A dead refresh token means the session is over; clear state so the UI
    // can redirect to sign-in rather than looping on failing requests.
    if (code === 'AUTH_SESSION_REVOKED' || code === 'AUTH_REFRESH_REUSE') {
      loseSession();
    }

    throw new ApiError(code, message, response.status, body?.error?.details);
  }

  const body = parsed as ApiEnvelope<T>;
  return body.data;
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) =>
    apiRequest<T>(path, { ...options, method: 'GET' }),

  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    apiRequest<T>(path, { ...options, method: 'POST', body }),

  patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    apiRequest<T>(path, { ...options, method: 'PATCH', body }),

  put: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    apiRequest<T>(path, { ...options, method: 'PUT', body }),

  delete: <T>(path: string, options?: RequestOptions) =>
    apiRequest<T>(path, { ...options, method: 'DELETE' }),
};

/** Envelope-aware GET that also returns `meta` — needed by paginated lists. */
export async function apiWithMeta<T>(
  path: string,
): Promise<{ data: T; meta: Record<string, unknown> }> {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
  });

  if (response.status === 401) {
    if (await refreshSession()) return apiWithMeta<T>(path);
  }

  const body = (await response.json()) as ApiEnvelope<T> | ApiErrorBody;

  if (!body.success) {
    throw new ApiError(body.error.code, body.error.message, response.status, body.error.details);
  }

  return { data: body.data, meta: body.meta };
}

/**
 * Upload one chunk as a raw binary body.
 *
 * Uses XMLHttpRequest rather than fetch, for one reason: fetch has no upload
 * progress event, and a progress bar is the difference between a 200MB upload
 * that feels alive and one that looks hung. It is the only place in the client
 * that uses XHR.
 */
export function uploadChunk(
  uploadId: string,
  chunkIndex: number,
  chunk: Blob,
  onProgress?: (loaded: number) => void,
  signal?: AbortSignal,
): Promise<{ receivedChunks: number; receivedChunksList: number[] }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `${API_BASE}/uploads/${uploadId}/chunks/${chunkIndex}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('content-type', 'application/octet-stream');

    if (accessToken) xhr.setRequestHeader('authorization', `Bearer ${accessToken}`);
    const csrf = readCookie('csrf');
    if (csrf) xhr.setRequestHeader('x-csrf-token', csrf);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded);
    };

    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText) as
          | ApiEnvelope<{ receivedChunks: number; receivedChunksList: number[] }>
          | ApiErrorBody;

        if (xhr.status >= 200 && xhr.status < 300 && body.success) {
          resolve(body.data);
        } else if (!body.success) {
          reject(new ApiError(body.error.code, body.error.message, xhr.status, body.error.details));
        } else {
          reject(new ApiError('UPLOAD_FAILED', 'Tải lên thất bại.', xhr.status));
        }
      } catch {
        reject(new ApiError('INVALID_RESPONSE', 'Phản hồi không hợp lệ.', xhr.status));
      }
    };

    xhr.onerror = () => reject(new ApiError('NETWORK_ERROR', 'Lỗi kết nối mạng.', 0));
    xhr.onabort = () => reject(new ApiError('UPLOAD_ABORTED', 'Đã huỷ tải lên.', 0));

    signal?.addEventListener('abort', () => xhr.abort());
    xhr.send(chunk);
  });
}
