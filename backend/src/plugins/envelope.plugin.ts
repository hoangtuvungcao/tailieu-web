import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

import { AppError, type ErrorCode, isOperationalError } from '../lib/errors.js';
import { isProduction } from '../config/env.js';

/**
 * Response envelope and central error handling.
 *
 * The envelope is applied in ONE place (an `onSend` hook) rather than in every
 * controller. That is deliberate: a controller that forgets to wrap its result
 * produces a response the frontend cannot parse, and with dozens of endpoints
 * somebody eventually will. Here, a handler simply returns a value and the
 * envelope is guaranteed.
 *
 * Error responses follow the same reasoning — one handler, one shape. Nothing
 * reaching this function ever exposes a stack trace, a SQL fragment, or an
 * upstream error string to the client.
 */
async function plugin(app: FastifyInstance): Promise<void> {
  app.decorateReply('ok', function ok(
    this: import('fastify').FastifyReply,
    data: unknown,
    meta?: Record<string, unknown>,
    message?: string | null,
  ) {
    this.header('content-type', 'application/json; charset=utf-8');
    return this.send({
      success: true,
      data: data ?? null,
      message: message ?? null,
      meta: meta ?? {},
    });
  });

  app.decorateReply('fail', function fail(
    this: import('fastify').FastifyReply,
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    const error = new AppError(code, message, details ? { details } : {});
    this.status(error.statusCode);
    this.header('content-type', 'application/json; charset=utf-8');
    return this.send(error.toResponse());
  });

  /**
   * Safety net for handlers that return a bare value.
   *
   * Wrapping happens only when the payload is a plain object that is not
   * already enveloped and not a stream. Buffers, streams and primitive
   * responses pass through untouched — an S3 passthrough must not be
   * JSON-encoded.
   */
  app.addHook('onSend', async (request, reply, payload) => {
    if (reply.statusCode >= 400) return payload;
    if (typeof payload !== 'string') return payload;
    if (reply.getHeader('content-type')?.toString().includes('application/json') === false) {
      return payload;
    }

    try {
      const parsed: unknown = JSON.parse(payload);
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        'success' in (parsed as Record<string, unknown>)
      ) {
        // Already enveloped by reply.ok / reply.fail.
        return payload;
      }
      return JSON.stringify({
        success: true,
        data: parsed,
        message: null,
        meta: {},
      });
    } catch {
      // Not JSON — a stream, a file, or an already-serialised body.
      return payload;
    }
  });

  app.setErrorHandler((error, request, reply) => {
    // --- Operational errors: expected, safe to describe to the client --------
    if (isOperationalError(error)) {
      // Rate limiting is the one 4xx class worth logging at info: a spike is
      // operationally interesting, whereas a wrong password is not.
      if (error.statusCode === 429) {
        request.log.info({ code: error.code, path: request.url }, 'rate limited');
      } else if (error.statusCode >= 500) {
        request.log.error({ err: error, code: error.code }, 'operational failure');
      } else {
        request.log.debug({ code: error.code, path: request.url }, 'request rejected');
      }

      if (error.retryAfterSeconds !== undefined) {
        reply.header('retry-after', String(error.retryAfterSeconds));
      }
      reply.status(error.statusCode);
      return reply.send(error.toResponse());
    }

    // --- Fastify's own validation errors, from route schemas ----------------
    if ((error as { validation?: unknown }).validation) {
      request.log.debug({ err: error }, 'schema validation failed');
      reply.status(422);
      return reply.send({
        success: false,
        error: {
          code: 'VALIDATION_FAILED',
          message: 'The request did not match the expected shape.',
          details: {
            issues: (error as { validation: unknown }).validation,
          },
        },
      });
    }

    // --- Errors that carry their own status, but are not AppErrors ----------
    // @fastify/rate-limit is the case that matters: its `errorResponseBuilder`
    // produces a plain object, so the error reaching here is not an AppError
    // and used to fall through to the 500 branch below. A rate-limited client
    // then saw "500 Internal Server Error" and could not tell "back off" from
    // "the server is broken" — the one distinction a 429 exists to make. A
    // client that retries on 500 also hammers harder exactly when it should
    // stop.
    const statusCode = (error as { statusCode?: number }).statusCode;
    const errorCode = (error as { code?: string }).code;

    if (statusCode === 429 || errorCode === 'RATE_LIMITED') {
      const retryAfter = (error as { ttl?: number }).ttl;
      if (retryAfter !== undefined) {
        reply.header('retry-after', String(Math.ceil(retryAfter / 1000)));
      }
      request.log.info({ path: request.url }, 'rate limited');
      reply.status(429);
      return reply.send({
        success: false,
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many requests. Please slow down and try again shortly.',
        },
      });
    }

    if (statusCode === 413) {
      reply.status(413);
      return reply.send({
        success: false,
        error: { code: 'PAYLOAD_TOO_LARGE', message: 'The request body was too large.' },
      });
    }

    // Any other error that declares a 4xx is a client problem and must not be
    // reported as a server fault.
    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
      request.log.debug({ err: error, statusCode }, 'client error');
      reply.status(statusCode);
      return reply.send({
        success: false,
        error: {
          code: errorCode ?? 'BAD_REQUEST',
          message: (error as Error).message || 'The request could not be processed.',
        },
      });
    }

    // --- Everything else: an unexpected bug ---------------------------------
    // Logged in full server-side; reported to the client as an opaque 500. The
    // real message might contain a SQL fragment, an internal hostname, or a
    // filesystem path — all useful reconnaissance.
    request.log.error({ err: error }, 'unhandled error');

    reply.status(500);
    return reply.send({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred. The incident has been logged.',
        // Surface the real message only outside production, where it is a
        // developer convenience rather than a disclosure.
        ...(isProduction ? {} : { details: { message: (error as Error).message } }),
      },
    });
  });

  app.setNotFoundHandler((request: FastifyRequest, reply) => {
    reply.status(404);
    return reply.send({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: `No route matches ${request.method} ${request.url}.`,
      },
    });
  });
}

export const envelopePlugin = fp(plugin, {
  name: 'envelope',
  fastify: '5.x',
});
