import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

import { AppError } from '../lib/errors.js';
import { verifyAccessToken } from '../lib/jwt.js';
import { findUserAuthRecord } from '../modules/rbac/rbac.repository.js';
import {
  getUserModerationScope,
  getUserPermissions,
  isSessionActive,
} from '../modules/rbac/rbac.service.js';
import type { AuthenticatedUser } from '../types/fastify.js';

/**
 * Authentication and authorization.
 *
 * Every check happens server-side. The frontend hides buttons it knows will
 * fail, but that is a UX affordance and never a security control — each route
 * below re-derives the answer from the database.
 *
 * The check order in `authenticate` is deliberate: cheap cryptographic
 * verification first, then the user record, then the session. A malformed or
 * forged token is rejected before any database work.
 *
 * BEARER ONLY. This never falls back to the `rt` cookie, and that is what makes
 * it correct that most mutating routes carry no `x-csrf-token` check. A browser
 * attaches cookies to a cross-site request automatically, but it never attaches
 * an `Authorization` header — so the access token cannot be replayed by a forged
 * form, and the token *is* the CSRF defence. The routes that genuinely need the
 * header are the cookie-authenticated ones (`/auth/refresh`, `/auth/logout`),
 * and those have it.
 *
 * Adding a cookie fallback here would silently reopen CSRF on every mutating
 * route in the application at once, with no test failing.
 */

/** Wildcard permission held by super_admin; short-circuits every check. */
const SUPERADMIN_PERMISSION = 'superadmin.all';

function extractBearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;

  const [scheme, token] = header.split(' ');
  // Case-insensitive: RFC 7235 defines the scheme as case-insensitive, and
  // clients do send "bearer".
  if (!token || scheme?.toLowerCase() !== 'bearer') return null;
  return token;
}

async function resolveUser(request: FastifyRequest, rawToken: string): Promise<AuthenticatedUser> {
  const claims = await verifyAccessToken(rawToken);

  // A primary-key lookup, deliberately uncached: `token_version` must be read
  // fresh, because it is the mechanism that makes "log out all devices" and
  // refresh-token-reuse response take effect immediately. Caching it would
  // reintroduce exactly the revocation delay that resolving permissions
  // server-side exists to avoid.
  const user = await findUserAuthRecord(claims.sub);
  if (!user) {
    throw new AppError('AUTH_TOKEN_INVALID', 'This account no longer exists.');
  }

  if (user.status === 'suspended') {
    throw new AppError('AUTH_ACCOUNT_SUSPENDED', 'This account is suspended.');
  }
  if (user.status === 'deactivated') {
    throw new AppError('AUTH_ACCOUNT_DEACTIVATED', 'This account has been deactivated.');
  }

  // The global kill switch. A mismatch means every token issued before the
  // last `token_version` bump is dead — a password change, a forced logout, or
  // detection of refresh-token reuse.
  if (claims.tv !== user.tokenVersion) {
    throw new AppError(
      'AUTH_SESSION_REVOKED',
      'Your session ended because your credentials changed. Please sign in again.',
    );
  }

  // Session-level revocation. Covers per-device logout, which must not affect
  // the user's other sessions and so cannot bump token_version.
  const sessionLive = await isSessionActive(claims.sid, user.id);
  if (!sessionLive) {
    throw new AppError('AUTH_SESSION_REVOKED', 'This session has been signed out.');
  }

  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    status: user.status,
    emailVerifiedAt: user.emailVerifiedAt,
    tokenVersion: user.tokenVersion,
    roles: claims.roles,
    sessionId: claims.sid,
    primaryFacultyId: user.primaryFacultyId,
    primaryProgramId: user.primaryProgramId,
  };
}

async function plugin(app: FastifyInstance): Promise<void> {
  /**
   * Require a valid access token. Rejects with 401 otherwise.
   *
   * Note there is no cookie fallback for the access token: it lives in memory
   * on the client. Only the refresh token is a cookie, and it is only accepted
   * by the refresh endpoint — so a CSRF-forged request cannot reach a
   * privileged route with a cookie alone.
   */
  app.decorate('authenticate', async function authenticate(
    request: FastifyRequest,
    _reply: FastifyReply,
  ): Promise<void> {
    const token = extractBearerToken(request);
    if (!token) {
      throw new AppError('UNAUTHORIZED', 'Authentication is required for this request.');
    }

    request.user = await resolveUser(request, token);
  });

  /** Populate request.user when a token is present, but never reject. */
  app.decorate('optionalAuth', async function optionalAuth(
    request: FastifyRequest,
    _reply: FastifyReply,
  ): Promise<void> {
    const token = extractBearerToken(request);
    if (!token) return;

    try {
      request.user = await resolveUser(request, token);
    } catch {
      // An invalid token on a public route is not an error — treat the caller
      // as anonymous. This keeps a stale token in a background tab from
      // breaking public browsing.
    }
  });

  /**
   * Require a permission. Returns a preHandler.
   *
   * `scope: 'faculty'` additionally loads the caller's moderation scope onto
   * the request. It does NOT enforce anything by itself — a scoped check is
   * only real if the repository query also filters by those faculty ids.
   * Treating this option as the enforcement point is the mistake that makes
   * faculty moderators able to moderate every faculty.
   */
  app.decorate('authorize', function authorize(
    permission: string,
    options?: { scope?: 'faculty' },
  ) {
    return async function authorizeHandler(
      request: FastifyRequest,
      _reply: FastifyReply,
    ): Promise<void> {
      if (!request.user) {
        throw new AppError('UNAUTHORIZED', 'Authentication is required for this request.');
      }

      const permissions = await getUserPermissions(request.user.id);
      request.permissions = permissions;

      const allowed =
        permissions.has(SUPERADMIN_PERMISSION) || permissions.has(permission);

      if (!allowed) {
        throw new AppError(
          'PERMISSION_DENIED',
          `You do not have permission to perform this action (${permission}).`,
        );
      }

      if (options?.scope === 'faculty') {
        request.moderationScope = await getUserModerationScope(request.user.id);
      }
    };
  });

  /** Expose the scope resolver for services that need it outside a preHandler. */
  app.decorate('getModerationScope', getUserModerationScope);
}

export const authPlugin = fp(plugin, {
  name: 'auth',
  fastify: '5.x',
  dependencies: ['envelope'],
});
