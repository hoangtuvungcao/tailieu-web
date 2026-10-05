import { randomUUID } from 'node:crypto';

import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';

import { env } from '../config/env.js';
import { AppError } from './errors.js';

/**
 * Access tokens (JWT).
 *
 * Deliberately carries roles but NOT the permission list. Two reasons:
 *
 *  1. Size. A user with the `admin` role holds 47 permissions; embedding them
 *     would inflate every request header for no benefit.
 *  2. Revocation. A 15-minute token whose permissions were baked in at issue
 *     time means revoking a moderator's rights takes up to 15 minutes to take
 *     effect. Permissions are resolved server-side per request (from a Redis
 *     cache with explicit invalidation), so a revocation is immediate.
 *
 * `tv` (token version) is the global kill switch: it is compared against
 * `users.token_version` on every request, so bumping that column invalidates
 * every outstanding access token for the user at once. That is what makes
 * "log out all devices" and refresh-token-reuse response instant rather than
 * eventual.
 */

const secretKey = new TextEncoder().encode(env.JWT_SECRET);

export interface AccessTokenClaims {
  /** User id. */
  sub: string;
  /** Session id — ties the token to a revocable session row. */
  sid: string;
  /** Token version, compared against users.token_version. */
  tv: number;
  /** Role keys, used for cheap display decisions and rank checks. */
  roles: string[];
}

export async function signAccessToken(claims: AccessTokenClaims): Promise<string> {
  return new SignJWT({ sid: claims.sid, tv: claims.tv, roles: claims.roles })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.sub)
    .setIssuer(env.JWT_ISSUER)
    .setAudience(env.JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(env.ACCESS_TOKEN_TTL)
    .setJti(randomUUID())
    .sign(secretKey);
}

/**
 * Verify signature, issuer, audience and expiry.
 *
 * Throws `AUTH_TOKEN_EXPIRED` for expiry specifically, because the frontend
 * needs to distinguish "refresh me" from "this token is garbage, log out".
 * Returning one generic 401 for both produces a client that either refreshes
 * forever or logs users out constantly.
 */
export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, secretKey, {
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      // Pin the algorithm. Without this, a token signed with `alg: none` or a
      // different algorithm could be accepted depending on library defaults —
      // the classic JWT confusion attack.
      algorithms: ['HS256'],
    });

    if (
      typeof payload.sub !== 'string' ||
      typeof payload.sid !== 'string' ||
      typeof payload.tv !== 'number' ||
      !Array.isArray(payload.roles)
    ) {
      throw new AppError('AUTH_TOKEN_INVALID', 'Access token is missing required claims.');
    }

    return {
      sub: payload.sub,
      sid: payload.sid,
      tv: payload.tv,
      roles: payload.roles.filter((r): r is string => typeof r === 'string'),
    };
  } catch (error) {
    if (error instanceof AppError) throw error;

    if (error instanceof joseErrors.JWTExpired) {
      throw new AppError('AUTH_TOKEN_EXPIRED', 'Access token has expired.', { cause: error });
    }

    throw new AppError('AUTH_TOKEN_INVALID', 'Access token is not valid.', { cause: error });
  }
}

/** Seconds until the configured access-token lifetime elapses. */
export function accessTokenTtlSeconds(): number {
  const ttl = env.ACCESS_TOKEN_TTL;
  const match = /^(\d+)([smhd])$/.exec(ttl);
  if (!match) return 900;
  const value = Number(match[1]);
  const unit = match[2];
  const multiplier = unit === 's' ? 1 : unit === 'm' ? 60 : unit === 'h' ? 3600 : 86_400;
  return value * multiplier;
}
