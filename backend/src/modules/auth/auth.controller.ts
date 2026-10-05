import type { FastifyReply, FastifyRequest } from 'fastify';

import { AppError } from '../../lib/errors.js';
import { csrfTokensMatch, tokenPrefix } from '../../lib/tokens.js';
import { parseBody } from '../../lib/validation.js';
import { isProduction } from '../../config/env.js';
import * as service from './auth.service.js';
import {
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  updateProfileSchema,
  verifyEmailSchema,
} from './auth.schema.js';

/**
 * Auth HTTP layer.
 *
 * Cookie policy, and the reasoning behind it:
 *
 *   rt    refresh token. httpOnly, so XSS cannot read it. Path is narrowed to
 *         /api/v1/auth so it is not attached to ordinary API calls — every
 *         request that carries a long-lived credential is another chance for
 *         it to leak into a log or a referrer.
 *
 *   csrf  readable by JavaScript, because the whole point of the double-submit
 *         pattern is that the client can read it and echo it in a header. It
 *         carries no authority on its own; an attacker who can read it is
 *         already same-origin.
 *
 * The access token is returned in the JSON body and kept in memory by the
 * client. It is never a cookie, so a CSRF-forged request cannot reach a
 * privileged endpoint carrying ambient authority.
 */

const REFRESH_COOKIE = 'rt';
const CSRF_COOKIE = 'csrf';
const REFRESH_COOKIE_PATH = '/api/v1/auth';

function cookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax' as const,
    path: REFRESH_COOKIE_PATH,
    maxAge: maxAgeSeconds,
  };
}

function setAuthCookies(reply: FastifyReply, tokens: service.AuthTokens, refreshMaxAgeSeconds: number): void {
  reply.setCookie(REFRESH_COOKIE, tokens.refreshToken, cookieOptions(refreshMaxAgeSeconds));

  // Only set when a new CSRF token was minted (login and registration). On
  // refresh the existing cookie is left untouched so other open tabs keep
  // working.
  if (tokens.csrfToken) {
    // Not httpOnly: the client must be able to read this to send it back as a
    // header. It is not a secret — it only proves the request came from a page
    // that could read this origin's cookies.
    reply.setCookie(CSRF_COOKIE, tokens.csrfToken, {
      httpOnly: false,
      secure: isProduction,
      sameSite: 'lax',
      path: '/',
      maxAge: refreshMaxAgeSeconds,
    });
  }
}

function clearAuthCookies(reply: FastifyReply): void {
  reply.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
  reply.clearCookie(CSRF_COOKIE, { path: '/' });
}

function contextOf(request: FastifyRequest): service.RequestContext {
  return {
    userAgent: request.headers['user-agent'] ?? null,
    ip: request.ip ?? null,
    requestId: request.id,
  };
}

const REFRESH_MAX_AGE = 30 * 24 * 60 * 60;

// =============================================================================

export async function register(request: FastifyRequest, reply: FastifyReply) {
  const body = parseBody(registerSchema, request.body);
  const { user, tokens } = await service.register(body, contextOf(request));
  setAuthCookies(reply, tokens, REFRESH_MAX_AGE);
  reply.status(201);
  return reply.ok(
    { user, accessToken: tokens.accessToken, expiresIn: tokens.expiresIn },
    {},
    'Account created.',
  );
}

export async function login(request: FastifyRequest, reply: FastifyReply) {
  const body = parseBody(loginSchema, request.body);
  const { user, tokens } = await service.login(body, contextOf(request));
  setAuthCookies(reply, tokens, REFRESH_MAX_AGE);
  return reply.ok({ user, accessToken: tokens.accessToken, expiresIn: tokens.expiresIn });
}

/**
 * Rotate the refresh token.
 *
 * Reads the token from the cookie only — never from the body. Accepting it in
 * a body parameter would let JavaScript move it into localStorage, which
 * converts an XSS from "read one cookie" into "exfiltrate a 30-day credential".
 */
export async function refresh(request: FastifyRequest, reply: FastifyReply) {
  const raw = request.cookies[REFRESH_COOKIE];

  if (!raw) {
    clearAuthCookies(reply);
    throw new AppError('AUTH_NO_REFRESH_TOKEN', 'No session to refresh. Please sign in.');
  }

  // A password-reset or verification token presented here is a client bug or a
  // probe. Reject before it reaches a database query.
  if (tokenPrefix(raw) !== 'rt') {
    clearAuthCookies(reply);
    throw new AppError('AUTH_REFRESH_INVALID', 'Invalid session token.');
  }

  try {
    const { user, tokens } = await service.refresh(raw, contextOf(request));
    setAuthCookies(reply, tokens, REFRESH_MAX_AGE);
    return reply.ok({ user, accessToken: tokens.accessToken, expiresIn: tokens.expiresIn });
  } catch (error) {
    // Any terminal refresh failure must clear the cookies, otherwise the
    // browser keeps replaying a dead token on every page load — and, once the
    // family is revoked, each replay looks like another reuse attempt.
    if (
      error instanceof AppError &&
      ['AUTH_REFRESH_INVALID', 'AUTH_REFRESH_EXPIRED', 'AUTH_REFRESH_REUSE', 'AUTH_SESSION_REVOKED'].includes(
        error.code,
      )
    ) {
      clearAuthCookies(reply);
    }
    // AUTH_REFRESH_RACE deliberately keeps the cookies: the client is expected
    // to retry immediately with the successor the other tab already stored.
    throw error;
  }
}

export async function logout(request: FastifyRequest, reply: FastifyReply) {
  const user = request.user!;
  await service.logout(user.sessionId, user.id);
  clearAuthCookies(reply);
  return reply.ok({ signedOut: true }, {}, 'Signed out.');
}

export async function logoutAll(request: FastifyRequest, reply: FastifyReply) {
  const user = request.user!;
  const count = await service.logoutAll(user.id);
  clearAuthCookies(reply);
  return reply.ok({ sessionsRevoked: count }, {}, 'Signed out of all devices.');
}

export async function listSessions(request: FastifyRequest, reply: FastifyReply) {
  const user = request.user!;
  const sessions = await service.listSessions(user.id, user.sessionId);
  return reply.ok(sessions);
}

export async function revokeSession(request: FastifyRequest, reply: FastifyReply) {
  const user = request.user!;
  const { id } = request.params as { id: string };
  await service.revokeSession(user.id, id, user.sessionId);
  return reply.ok({ revoked: true }, {}, 'Session signed out.');
}

export async function me(request: FastifyRequest, reply: FastifyReply) {
  const user = request.user!;
  const profile = await service.getCurrentUser(user.id);
  return reply.ok(profile);
}

/**
 * Update the parts of a profile the account owns.
 *
 * CSRF-guarded like every other state-changing route that authenticates from a
 * header: the access token is in memory rather than a cookie, so a forged
 * cross-site request cannot carry it — but adding the guard costs one header
 * check and removes the need to reason about that per route.
 */
export async function updateMe(request: FastifyRequest, reply: FastifyReply) {
  const user = request.user!;
  const body = parseBody(updateProfileSchema, request.body);
  const updated = await service.updateProfile(user.id, body);
  return reply.ok(updated, {}, 'Đã cập nhật hồ sơ.');
}

/**
 * Upload an avatar or a cover image.
 *
 * Read into a buffer rather than streamed to storage, unlike a document
 * upload. The bytes have to be inspected before anything is written — an image
 * is the one upload class the browser renders on this origin — and at 2MB
 * (5MB for a cover) buffering one image per request is bounded and cheap. The
 * multipart plugin's own limit is the outer bound; this is the inner one.
 */
function imageHandler(kind: service.ProfileImageKind) {
  return async function uploadProfileImage(request: FastifyRequest, reply: FastifyReply) {
    const user = request.user!;

    if (!request.isMultipart()) {
      throw new AppError('BAD_REQUEST', 'Yêu cầu phải là multipart/form-data.');
    }

    const part = await request.file();
    if (!part) {
      throw new AppError('BAD_REQUEST', 'Không tìm thấy tệp nào trong yêu cầu.');
    }

    // `toBuffer` enforces the plugin's `fileSize` limit and throws
    // FST_REQ_FILE_TOO_LARGE past it, which the error handler maps to a 413.
    // The per-kind limit in the service is tighter and gives a message naming
    // the actual budget.
    const buffer = await part.toBuffer();

    const updated = await service.replaceProfileImage(
      user.id,
      kind,
      buffer,
      part.filename,
      part.mimetype ?? null,
    );

    return reply.ok(
      updated,
      {},
      kind === 'avatar' ? 'Đã cập nhật ảnh đại diện.' : 'Đã cập nhật ảnh bìa.',
    );
  };
}

export const uploadAvatar = imageHandler('avatar');
export const uploadCover = imageHandler('cover');

function clearHandler(kind: service.ProfileImageKind) {
  return async function clearProfileImage(request: FastifyRequest, reply: FastifyReply) {
    const user = request.user!;
    const updated = await service.clearProfileImage(user.id, kind);
    return reply.ok(
      updated,
      {},
      kind === 'avatar' ? 'Đã xoá ảnh đại diện.' : 'Đã xoá ảnh bìa.',
    );
  };
}

export const deleteAvatar = clearHandler('avatar');
export const deleteCover = clearHandler('cover');

export async function verifyEmail(request: FastifyRequest, reply: FastifyReply) {
  const body = parseBody(verifyEmailSchema, request.body);
  await service.verifyEmail(body.token);
  return reply.ok({ verified: true }, {}, 'Email address verified.');
}

export async function resendVerification(request: FastifyRequest, reply: FastifyReply) {
  const user = request.user!;
  await service.resendVerification(user.id);
  return reply.ok({ sent: true }, {}, 'Verification email sent.');
}

export async function forgotPassword(request: FastifyRequest, reply: FastifyReply) {
  const body = parseBody(forgotPasswordSchema, request.body);
  await service.requestPasswordReset(body.email);
  // Always the same response, whether or not the address exists.
  return reply.ok(
    { sent: true },
    {},
    'If that email address is registered, a reset link has been sent.',
  );
}

export async function resetPassword(request: FastifyRequest, reply: FastifyReply) {
  const body = parseBody(resetPasswordSchema, request.body);
  await service.resetPassword(body.token, body.password);
  clearAuthCookies(reply);
  return reply.ok(
    { reset: true },
    {},
    'Password updated. All other devices have been signed out.',
  );
}

/**
 * Double-submit CSRF guard.
 *
 * Requires the `csrf` cookie and the `X-CSRF-Token` header to match. A
 * cross-site attacker can cause the browser to SEND the cookie but cannot read
 * it to populate the header, so a forged request fails here.
 *
 * Applied to state-changing endpoints that rely on cookie authority. Login,
 * registration and password reset are exempt because they carry no ambient
 * authority — an attacker forging a login only logs the victim into the
 * attacker's account, which is not a useful attack.
 */
export async function csrfGuard(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const cookieToken = request.cookies[CSRF_COOKIE];
  const headerToken = request.headers['x-csrf-token'];

  if (!cookieToken || typeof headerToken !== 'string' || !csrfTokensMatch(cookieToken, headerToken)) {
    throw new AppError(
      'AUTH_CSRF_INVALID',
      'This request could not be verified as coming from the site. Please reload and try again.',
    );
  }
}
