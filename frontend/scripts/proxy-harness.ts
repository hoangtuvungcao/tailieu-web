/**
 * Exercises the Pages Function against the real backend.
 *
 * Node 20 provides the same Request/Response/fetch globals the Workers runtime
 * does, so the function body can be called directly with a mocked context. This
 * catches the things that actually break a proxy — dropped Set-Cookie headers,
 * mangled query strings, non-streamed bodies — without needing wrangler.
 */
import { onRequest } from '../functions/api/[[path]]';

const ORIGIN = 'http://localhost:4000';

async function call(path: string, init: RequestInit = {}) {
  const request = new Request(`https://tailieu.5125121.com${path}`, init);
  const url = new URL(request.url);
  const suffix = url.pathname.replace(/^\/api\/?/, '');

  return onRequest({
    request,
    env: { API_ORIGIN: ORIGIN },
    params: { path: suffix.split('/').filter(Boolean) },
    // Unused by the function; present so the shape matches.
    data: {},
    next: async () => new Response('not found', { status: 404 }),
    functionPath: '/api/[[path]]',
    waitUntil: () => {},
  } as never);
}

const results: [string, boolean, string][] = [];
function check(name: string, ok: boolean, detail = '') {
  results.push([name, ok, detail]);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

console.log('\nPages Function proxy harness\n');

// 1. Simple GET
{
  const res = await call('/api/v1/taxonomy/faculties?limit=3');
  const body = await res.json() as { success?: boolean; data?: unknown[] };
  check('GET proxies JSON', res.status === 200 && body.success === true,
    `HTTP ${res.status}`);
}

// 2. Query string preserved exactly
{
  const res = await call('/api/v1/search/suggest?q=c%C3%B4ng&limit=5');
  const body = await res.json() as { data?: { label: string }[] };
  check('query string preserved (encoded Vietnamese)', res.status === 200 && (body.data?.length ?? 0) > 0,
    `${body.data?.length ?? 0} suggestions`);
}

// 3. Login sets TWO cookies — the case a naive header copy silently breaks
{
  const res = await call('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'student@tailieu.local', password: 'ChangeMe_Student_2026' }),
  });
  const cookies = res.headers.getSetCookie();
  const names = cookies.map((c) => c.split('=')[0]).sort();
  check('both Set-Cookie headers survive', cookies.length === 2,
    names.join(', ') || 'none');
  check('refresh cookie is HttpOnly', cookies.some((c) => c.startsWith('rt=') && /HttpOnly/i.test(c)));
  check('csrf cookie is NOT HttpOnly (JS must read it)',
    cookies.some((c) => c.startsWith('csrf=') && !/HttpOnly/i.test(c)));
}

// 4. Streaming request body — the chunked upload path
{
  // 1MB of binary, deliberately not JSON.
  const payload = new Uint8Array(1024 * 1024).fill(65);
  const login = await call('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'student@tailieu.local', password: 'ChangeMe_Student_2026' }),
  });
  const token = ((await login.json()) as { data: { accessToken: string } }).data.accessToken;
  const csrf = (login.headers.getSetCookie().find((c) => c.startsWith('csrf=')) ?? '').split('=')[1]?.split(';')[0] ?? '';

  const intentRes = await call('/api/v1/uploads', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-csrf-token': csrf },
    body: JSON.stringify({ fileName: 'proxy-test.pdf', sizeBytes: payload.length, mimeType: 'application/pdf' }),
  });
  const intent = (await intentRes.json()) as { data?: { uploadId: string }; error?: { code: string } };

  if (!intent.data) {
    check('upload intent via proxy', false, JSON.stringify(intent.error));
  } else {
    // PDF header so magic-byte validation passes.
    payload.set(new TextEncoder().encode('%PDF-1.4\n'), 0);
    const chunkRes = await call(`/api/v1/uploads/${intent.data.uploadId}/chunks/0`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${token}`, 'x-csrf-token': csrf },
      body: payload,
      // Mirrors what the browser and the function both do for a stream body.
      duplex: 'half',
    } as RequestInit);
    const chunkBody = (await chunkRes.json()) as { success?: boolean; data?: { receivedChunks: number }; error?: { message: string } };
    check('streamed 1MB binary chunk through the proxy',
      chunkRes.status === 200 && chunkBody.success === true,
      chunkBody.error?.message ?? `HTTP ${chunkRes.status}`);
  }
}

// 5. Upstream down -> 502 with a usable message, not an opaque crash
{
  const request = new Request('https://tailieu.5125121.com/api/v1/health');
  const res = await onRequest({
    request,
    env: { API_ORIGIN: 'http://127.0.0.1:9' },
    params: { path: ['v1', 'health'] },
    data: {}, next: async () => new Response(''), functionPath: '', waitUntil: () => {},
  } as never);
  const body = (await res.json()) as { error?: { code: string } };
  check('unreachable upstream returns 502 UPSTREAM_UNAVAILABLE',
    res.status === 502 && body.error?.code === 'UPSTREAM_UNAVAILABLE');
}

const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exitCode = 1;
