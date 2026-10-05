import { randomUUID } from 'node:crypto';

import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';

import { env, isProduction } from './config/env.js';
import { redis } from './db/redis.js';
import { authPlugin } from './plugins/auth.plugin.js';
import { envelopePlugin } from './plugins/envelope.plugin.js';
import { systemStatePlugin } from './plugins/system-state.plugin.js';
import { registerRoutes } from './routes/index.js';

/**
 * Application assembly.
 *
 * Kept separate from `server.ts` so tests can build an app instance without
 * binding a port or installing signal handlers.
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    // Trust the proxy header only when explicitly configured. Behind
    // Cloudflare Tunnel the true client IP arrives in X-Forwarded-For, and
    // rate limiting keyed on the tunnel's address would throttle everyone as
    // one client. Trusting it unconditionally would let anyone spoof their IP
    // and bypass rate limits, so it is opt-in.
    trustProxy: env.TRUST_PROXY,

    // Request ids correlate an API log line, a response header, and the
    // audit_logs row written during that request.
    genReqId: (request) => {
      const existing = request.headers['cf-ray'] ?? request.headers['x-request-id'];
      return typeof existing === 'string' ? existing : randomUUID();
    },

    // Fastify's default body limit is 1MB. Document uploads travel in ~8MB
    // chunks, so the JSON/multipart limit must clear that — but no higher,
    // since every byte is buffered for non-multipart content types.
    bodyLimit: Math.ceil(env.UPLOAD_CHUNK_SIZE_BYTES * 1.2),

    logger: {
      level: env.LOG_LEVEL,
      // Never log credentials or cookies. Pino redacts by path, so this
      // catches them wherever they appear in a logged object.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
          'req.body.password',
          'req.body.currentPassword',
          'req.body.newPassword',
          'req.body.token',
          'req.body.refreshToken',
        ],
        censor: '[redacted]',
      },
      ...(isProduction
        ? {}
        : {
            transport: {
              target: 'pino-pretty',
              options: {
                colorize: true,
                translateTime: 'HH:MM:ss.l',
                ignore: 'pid,hostname',
              },
            },
          }),
    },
  });

  // --- Security headers ------------------------------------------------------
  await app.register(helmet, {
    // The API returns only JSON and file streams; it never serves an HTML
    // document. A restrictive CSP here is belt-and-braces against a future
    // endpoint that reflects user content.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
    // The API is never embedded in a frame. The CSP directive above already
    // says `frame-ancestors 'none'`, and modern browsers prefer it — but the
    // header is what older clients honour, and leaving it at helmet's
    // SAMEORIGIN default would contradict the CSP and invite a clickjacking
    // gap on any browser that reads only one of the two.
    xFrameOptions: { action: 'deny' },
    // Not enabled: the frontend is a different origin in local dev and the
    // same origin in production; either way the API is not embedded.
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  });

  // Permissions-Policy is not one of helmet's defaults. The API needs none of
  // these features, so denying them all removes a class of attack where
  // injected content reaches for a device capability.
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header(
      'permissions-policy',
      'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
    );
    return payload;
  });

  // --- CORS ------------------------------------------------------------------
  // In production the Pages Function proxies /api/* so requests are
  // same-origin and CORS never applies. This list therefore matters for local
  // development and acts as defence in depth for anything reaching the API
  // directly. `credentials: true` requires an explicit origin list — a
  // wildcard is rejected at config load.
  await app.register(cors, {
    origin(origin, callback) {
      // No Origin header: a same-origin request, a server-to-server call, or a
      // health check. Not a CORS request at all.
      if (!origin) return callback(null, true);
      if (env.CORS_ORIGINS.includes(origin)) return callback(null, true);
      callback(new Error(`Origin ${origin} is not permitted.`), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization', 'x-csrf-token', 'x-request-id'],
    exposedHeaders: ['x-request-id', 'retry-after', 'content-disposition'],
    maxAge: 600,
  });

  // --- Cookies ---------------------------------------------------------------
  await app.register(cookie, {
    secret: env.CSRF_SECRET,
    parseOptions: {
      // Lax rather than Strict: the OAuth redirect back from Google is a
      // top-level navigation, and Strict would drop the cookie on arrival.
      // Lax still blocks the cross-site POSTs that CSRF relies on.
      sameSite: 'lax',
      httpOnly: true,
      secure: isProduction,
      path: '/',
      ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
    },
  });

  // --- Rate limiting ---------------------------------------------------------
  // Redis-backed so the limit is shared across processes and survives a
  // restart. The global limit is a backstop; per-route limits in the auth
  // module are the ones that actually protect against credential stuffing and
  // against exhausting the Argon2 memory budget.
  await app.register(rateLimit, {
    global: true,
    max: env.RATE_LIMIT_GLOBAL_PER_MIN,
    timeWindow: '1 minute',
    redis,
    // Key on the authenticated user when known, so one abusive account cannot
    // hide behind a shared NAT address — and so an office full of students
    // behind one IP does not throttle each other.
    keyGenerator: (request) =>
      request.user ? `user:${request.user.id}` : `ip:${request.ip}`,
    allowList: () => env.NODE_ENV === 'test',
    // No `errorResponseBuilder`. Returning a custom object here replaces the
    // thrown error with that object, so it arrives at the error handler with no
    // `statusCode` — and fell through to the generic 500 branch. The default
    // error carries `statusCode: 429` and `ttl`, which the central handler
    // formats into the standard envelope with a Retry-After header.
    //
    // Formatting rate-limit responses centrally also means they cannot drift
    // from every other error the API returns.
  });

  // --- Multipart -------------------------------------------------------------
  // Used only by the single-shot upload path; chunked uploads send raw
  // application/octet-stream bodies with the chunk index in the URL.
  await app.register(multipart, {
    limits: {
      fileSize: env.MAX_UPLOAD_SIZE_BYTES,
      files: env.MAX_FILES_PER_DOCUMENT,
      fields: 40,
      fieldSize: 1024 * 100,
    },
    // Stream to disk-less handlers; `attachFieldsToBody` would buffer every
    // file into memory and cap upload size at available RAM.
    attachFieldsToBody: false,
  });

  // --- Raw binary bodies -----------------------------------------------------
  // Chunk uploads send raw bytes, not multipart. The parser hands the handler
  // the request stream untouched so the chunk can be piped straight to S3.
  //
  // Fastify buffers unknown content types by default, which for an 8MB chunk
  // means holding every in-flight chunk in memory at once. Returning the
  // stream keeps memory flat no matter how many uploads run concurrently.
  app.addContentTypeParser(
    'application/octet-stream',
    (_request, payload, done) => {
      done(null, payload);
    },
  );

  // --- Application plugins ---------------------------------------------------
  // Order matters: envelope installs the error handler and reply helpers that
  // everything else uses; auth depends on it.
  await app.register(envelopePlugin);
  await app.register(authPlugin);
  // Registered after the envelope so its AppErrors are formatted by the
  // central handler, and before routes so no endpoint can bypass it.
  await app.register(systemStatePlugin);

  // Attach the correlation id to every response so a user can quote it when
  // reporting a problem and it can be grepped straight out of the logs.
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  await registerRoutes(app);

  return app;
}
