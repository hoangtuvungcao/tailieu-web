/**
 * Cloudflare Pages Function — API proxy.
 *
 * Routes /api/* to the backend running on the laptop, reached through a
 * Cloudflare Tunnel. Two things make this worth doing rather than pointing the
 * frontend straight at the tunnel's hostname:
 *
 *   1. SAME ORIGIN. The browser sees one origin for the site and the API, so
 *      there is no cross-origin request, no preflight, and no CORS
 *      configuration to get wrong. The refresh cookie is first-party, which
 *      also means `SameSite=Lax` behaves as intended.
 *
 *   2. NO FIXED IP. The tunnel hostname is stable while the laptop's address is
 *      not. Nothing public ever points at an IP.
 *
 * Two constraints shape the code below, and both are easy to get wrong in a
 * way that only fails in production:
 *
 *   STREAMING IS MANDATORY. Cloudflare buffers a request body only if you let
 *   it, and the Workers runtime is memory-limited. Reading `request.body` into
 *   an ArrayBuffer — which is the obvious thing to write — caps uploads at the
 *   runtime's memory and gives a 1102 "Worker exceeded resource limits" error
 *   on a large file. The body must be piped through untouched, which requires
 *   `duplex: 'half'`.
 *
 *   THE 100MB REQUEST CAP. Cloudflare refuses proxied request bodies above
 *   100MB regardless of what this code does. That is why the client uploads in
 *   ~8MB chunks: it is not a design preference, it is the only way a 300MB
 *   thesis can be uploaded at all.
 */

interface Env {
  /**
   * Origin of the backend as reachable from Cloudflare — the tunnel hostname,
   * e.g. https://api-internal.tailieu.5125121.com. Set in the Pages project's
   * environment variables for both production and preview.
   *
   * It is NOT the public site origin. Pointing this at tailieu.5125121.com
   * would make the Worker call itself in a loop.
   */
  API_ORIGIN?: string;
}

/** Used when API_ORIGIN is unset, so a misconfigured deploy fails loudly. */
const FALLBACK_ORIGIN = 'http://localhost:3000';

/**
 * Request headers that must not be forwarded.
 *
 * `host` would arrive at the backend claiming to be the public site, which
 * breaks virtual-host routing and any absolute-URL generation. `cf-*` headers
 * describe the Cloudflare edge to itself and confuse an origin server that
 * tries to interpret them. `content-length` is recomputed by fetch from the
 * actual stream — forwarding the original while the body is re-chunked
 * produces a mismatch the backend rejects.
 */
const STRIPPED_REQUEST_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'cf-connecting-ip',
  'cf-ipcountry',
  'cf-ray',
  'cf-visitor',
  'cf-worker',
  'x-forwarded-proto',
  'x-forwarded-for',
]);

/**
 * Response headers that must not be copied back.
 *
 * `content-length` and `content-encoding` are the important ones: the body is
 * returned as a stream and the edge re-encodes it, so a forwarded
 * content-length would describe the wrong number of bytes and a forwarded
 * content-encoding would tell the browser to gunzip something that is not
 * gzipped. `set-cookie` is handled separately because it may appear multiple
 * times and a plain Headers copy collapses it to one.
 */
const STRIPPED_RESPONSE_HEADERS = new Set([
  'content-length',
  'content-encoding',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'set-cookie',
]);

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env, params } = context;

  const origin = env.API_ORIGIN ?? FALLBACK_ORIGIN;

  // `params.path` is the catch-all segment. Pages gives it as string[] for a
  // [[path]] route; join defensively in case a single string is ever passed.
  const segments = params.path;
  const suffix = Array.isArray(segments) ? segments.join('/') : (segments ?? '');

  const incoming = new URL(request.url);
  const target = new URL(`/api/${suffix}`, origin);
  // Preserve the query string exactly — filters, pagination and the signed-URL
  // parameters all live there, and re-encoding can change their meaning.
  target.search = incoming.search;

  // --- Request headers -----------------------------------------------------
  const headers = new Headers();
  for (const [key, value] of request.headers) {
    if (STRIPPED_REQUEST_HEADERS.has(key.toLowerCase())) continue;
    headers.set(key, value);
  }

  // The backend needs the real client IP for rate limiting and abuse
  // investigation. Cloudflare sets cf-connecting-ip, which was stripped above
  // because it confuses an origin that does not expect it — so it is
  // re-attached under the standard name instead.
  const clientIp = request.headers.get('cf-connecting-ip');
  if (clientIp) headers.set('x-forwarded-for', clientIp);
  headers.set('x-forwarded-proto', incoming.protocol.replace(':', ''));

  // --- Body ----------------------------------------------------------------
  // GET and HEAD must not carry a body; passing one is a runtime error rather
  // than a silent no-op. `duplex: 'half'` is required by the fetch spec for a
  // streaming request body and is unsupported on GET/HEAD anyway.
  const hasBody = !['GET', 'HEAD'].includes(request.method) && request.body !== null;

  let upstream: Response;
  try {
    upstream = await fetch(target.toString(), {
      method: request.method,
      headers,
      ...(hasBody
        ? {
            body: request.body,
            duplex: 'half',
          }
        : {}),
      // Do not follow redirects. A redirect here would be the backend sending
      // the client to a signed storage URL, and following it server-side would
      // stream the file through the Worker — burning CPU and hiding the
      // redirect the client needs to see.
      redirect: 'manual',
    });
  } catch (error) {
    // The tunnel is down, or the laptop is asleep. A 502 with a clear message
    // is far more useful than the opaque 500 an unhandled throw produces.
    return new Response(
      JSON.stringify({
        success: false,
        error: {
          code: 'UPSTREAM_UNAVAILABLE',
          message:
            'Máy chủ đang tạm thời không phản hồi. Vui lòng thử lại sau ít phút.',
        },
      }),
      {
        status: 502,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      },
    );
  }

  // --- Response headers ----------------------------------------------------
  const responseHeaders = new Headers();
  for (const [key, value] of upstream.headers) {
    if (STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) continue;
    responseHeaders.set(key, value);
  }

  // Cookies need explicit handling. A Headers object cannot hold two values for
  // the same key, so copying normally would silently drop one of the two
  // cookies the login response sets (refresh + CSRF) and break authentication
  // in a way that looks like a server bug. Cloudflare has getSetCookie() for
  // exactly this.
  const setCookies = upstream.headers.getSetCookie?.() ?? [];
  for (const cookie of setCookies) {
    responseHeaders.append('set-cookie', cookie);
  }

  // Do not let a stale cached response serve one user's data to another. The
  // API sends no cache headers of its own, so this is the safety net.
  if (!responseHeaders.has('cache-control')) {
    responseHeaders.set('cache-control', 'no-store');
  }

  // The body is passed through as a stream. `await upstream.arrayBuffer()`
  // would buffer the whole download in the Worker's memory — fine for a JSON
  // error, fatal for a 200MB file.
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
};
